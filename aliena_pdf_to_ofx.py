#!/usr/bin/env python3
"""Convert Aliena/DriveWealth trade confirmation PDFs into OFX investment files.

This script parses transaction confirmation PDFs whose first page includes one or
more trade rows and emits OFX 1.0.2 investment statement files suitable for
import into tools such as Quicken.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable

from pypdf import PdfReader


@dataclass
class FeeLine:
    label: str
    amount: Decimal


@dataclass
class Trade:
    account_id: str
    confirmation_date: datetime
    trade_date: datetime
    settle_date: datetime
    action: str
    symbol: str
    security_name: str
    quantity: Decimal
    unit_price: Decimal
    principal_amount: Decimal
    net_amount: Decimal
    commission: Decimal
    fee_lines: list[FeeLine]
    source_file: str


def parse_us_date(value: str) -> datetime:
    return datetime.strptime(value.strip(), "%m/%d/%Y")


def parse_amount(value: str) -> Decimal:
    text = value.strip().replace(",", "")
    if text.startswith("(") and text.endswith(")"):
        text = "-" + text[1:-1]
    text = text.replace("$", "").replace(" ", "")
    try:
        return Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"Could not parse amount from '{value}'") from exc


def parse_decimal(value: str) -> Decimal:
    try:
        return Decimal(value.strip())
    except InvalidOperation as exc:
        raise ValueError(f"Could not parse decimal from '{value}'") from exc


def extract_all_pages_lines(pdf_path: Path) -> list[str]:
    reader = PdfReader(str(pdf_path))
    lines: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        lines.extend(line.strip() for line in text.splitlines() if line.strip())
    return lines


def find_label_value(lines: list[str], label: str) -> str:
    for idx, line in enumerate(lines):
        if line == label and idx + 1 < len(lines):
            return lines[idx + 1]
    raise ValueError(f"Label '{label}' not found")


def parse_trades_from_pdf(pdf_path: Path) -> list[Trade]:
    lines = extract_all_pages_lines(pdf_path)
    if not lines:
        return []

    account_id = find_label_value(lines, "Account Number:")
    confirmation_date = parse_us_date(find_label_value(lines, "Confirmation Date  :"))

    trades: list[Trade] = []
    i = 0
    while i < len(lines):
        if lines[i] not in {"Buy", "Sell"}:
            i += 1
            continue

        if i < 3:
            i += 1
            continue

        action = lines[i]
        symbol = lines[i - 3]
        security_name = lines[i - 2]
        quantity = parse_decimal(lines[i + 2])
        unit_price = parse_decimal(lines[i + 3])
        trade_date = parse_us_date(lines[i + 4])
        settle_date = parse_us_date(lines[i + 5])

        end_idx = i + 6
        principal_amount = Decimal("0")
        net_amount = Decimal("0")
        commission = Decimal("0")
        fee_lines: list[FeeLine] = []

        j = i + 6
        while j < len(lines):
            line = lines[j]
            if line in {"Buy", "Sell"} and j >= 3:
                break
            if line == "Principal Amount" and j + 1 < len(lines):
                principal_amount = parse_amount(lines[j + 1])
            elif line == "Commission" and j + 1 < len(lines):
                commission = parse_amount(lines[j + 1])
            elif line == "Transaction Fee" and j + 1 < len(lines):
                fee_lines.append(FeeLine(label=line, amount=parse_amount(lines[j + 1])))
            elif line == "Other Fees / Credits" and j + 1 < len(lines):
                fee_lines.append(FeeLine(label=line, amount=parse_amount(lines[j + 1])))
            elif line == "Net Amount" and j + 1 < len(lines):
                net_amount = parse_amount(lines[j + 1])
                end_idx = j + 2
                break
            j += 1

        trades.append(
            Trade(
                account_id=account_id,
                confirmation_date=confirmation_date,
                trade_date=trade_date,
                settle_date=settle_date,
                action=action,
                symbol=symbol,
                security_name=security_name,
                quantity=abs(quantity),
                unit_price=unit_price,
                principal_amount=principal_amount,
                net_amount=net_amount,
                commission=commission,
                fee_lines=fee_lines,
                source_file=pdf_path.name,
            )
        )

        i = end_idx

    return trades


def ofx_date(dt: datetime) -> str:
    return dt.strftime("%Y%m%d000000")


def dec_str(value: Decimal, places: int = 8) -> str:
    quant = Decimal("1").scaleb(-places)
    normalized = value.quantize(quant).normalize()
    text = format(normalized, "f")
    return text


def decimal_places(value: Decimal) -> int:
    exp = value.normalize().as_tuple().exponent
    return -exp if exp < 0 else 0


def fee_total(trade: Trade) -> Decimal:
    return sum((abs(fee.amount) for fee in trade_fee_lines(trade)), Decimal("0"))


def fee_summary(trade: Trade) -> str:
    fee_lines = trade_fee_lines(trade)
    if not fee_lines:
        return "none"
    return "; ".join(f"{fee.label}={dec_str(fee.amount, 2)}" for fee in fee_lines)


def trade_fee_lines(trade: Trade) -> list[FeeLine]:
    fee_lines = [fee for fee in trade.fee_lines if fee.amount != 0]
    if trade.action == "Sell" and trade.commission != 0:
        fee_lines = [FeeLine(label="Commission", amount=trade.commission)] + fee_lines
    return fee_lines


def quicken_fee_category(label: str) -> str:
    normalized = label.strip().lower()
    if normalized == "transaction fee":
        return "Fees and Charges:Transaction Fee"
    if normalized == "other fees / credits":
        return "Fees and Charges:Other Fees"
    if normalized == "commission":
        return "Fees and Charges:Commission"
    return "Fees and Charges:Other Fees"


def fee_memo(trade: Trade, fee: FeeLine) -> str:
    category = quicken_fee_category(fee.label)
    return (
        f"{trade.source_file}; category={category}; "
        f"fee={fee.label}; amount={fee.amount}"
    )


def calc_total_for_ofx(trade: Trade, separate_sell_expenses: bool = False) -> Decimal:
    # Prefer the explicit net amount because it already reflects sell-side fees.
    # When sell-side fees are emitted as separate INVEXPENSE entries for OFX,
    # use gross proceeds implied by units*unit_price so Quicken's derived share
    # price (TOTAL/UNITS) matches the statement UNITPRICE.
    # For buy and sell price fidelity in Quicken, prefer gross proceeds/cost
    # implied by units*unit_price and keep fees/commission in their dedicated
    # fields/transactions.
    gross = abs(trade.principal_amount)
    net = abs(trade.net_amount)
    gross_from_price = abs(trade.quantity * trade.unit_price)

    if trade.action == "Sell":
        base = (gross_from_price if gross_from_price > Decimal("0") else gross) if separate_sell_expenses else net
    else:
        base = gross_from_price if gross_from_price > Decimal("0") else gross
    signed = base if trade.action == "Sell" else -base
    return signed


def trade_total_places(trade: Trade) -> int:
    # Preserve enough precision for TOTAL/UNITS to reproduce UNITPRICE.
    return min(16, max(8, decimal_places(trade.quantity) + decimal_places(trade.unit_price)))


def make_fee_fitid(trade: Trade, ordinal: int, fee_index: int, fee: FeeLine) -> str:
    payload = "|".join(
        [
            trade.account_id,
            trade.source_file,
            str(ordinal),
            trade.symbol,
            trade.action,
            "FEE",
            str(fee_index),
            fee.label,
            ofx_date(trade.trade_date),
            dec_str(fee.amount, 2),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:24]


def summarize_positions(trades: Iterable[Trade]) -> dict[str, tuple[Decimal, Decimal]]:
    """Return ending units and last observed unit price per symbol."""
    positions: dict[str, tuple[Decimal, Decimal]] = {}
    for t in sorted(trades, key=lambda x: (x.trade_date, x.settle_date, x.symbol)):
        current_units, _current_price = positions.get(t.symbol, (Decimal("0"), t.unit_price))
        signed_units = t.quantity if t.action == "Buy" else -t.quantity
        positions[t.symbol] = (current_units + signed_units, t.unit_price)
    return positions


def make_fitid(trade: Trade, ordinal: int) -> str:
    payload = "|".join(
        [
            trade.account_id,
            trade.source_file,
            str(ordinal),
            trade.symbol,
            trade.action,
            ofx_date(trade.trade_date),
            dec_str(trade.quantity),
            dec_str(trade.unit_price),
        ]
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()[:24]


def append_text(parent: ET.Element, tag: str, value: str) -> ET.Element:
    node = ET.SubElement(parent, tag)
    node.text = value
    return node


def safe_sgml_text(value: str) -> str:
    # Avoid malformed SGML tokens in fields like security names and memos.
    return value.replace("&", " and ").replace("<", "(").replace(">", ")")


def normalize_account_id_for_quicken(account_id: str) -> str:
    digits = "".join(ch for ch in account_id if ch.isdigit())
    if digits:
        return digits[-12:]
    cleaned = re.sub(r"[^A-Za-z0-9]", "", account_id)
    return cleaned[-12:] if cleaned else account_id


def build_ofx(
    account_id: str,
    trades: list[Trade],
    broker_id: str,
    intu_bid: str | None = None,
    fi_org: str | None = None,
    fi_fid: str | None = None,
) -> str:
    if not trades:
        raise ValueError("No trades provided")

    trades_sorted = sorted(trades, key=lambda t: (t.trade_date, t.source_file, t.symbol))
    dt_start = ofx_date(min(t.trade_date for t in trades_sorted))
    dt_end = ofx_date(max(t.trade_date for t in trades_sorted))

    symbols: dict[str, str] = {}
    for t in trades_sorted:
        symbols[t.symbol] = t.security_name
    positions = summarize_positions(trades_sorted)

    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    lines = [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "SECURITY:NONE",
        "ENCODING:USASCII",
        "CHARSET:1252",
        "COMPRESSION:NONE",
        "OLDFILEUID:NONE",
        "NEWFILEUID:NONE",
    ]

    if intu_bid:
        lines.append(f"INTU.BID:{intu_bid}")

    lines.extend(
        [
            "",
            "<OFX>",
            "<SIGNONMSGSRSV1>",
            "<SONRS>",
            "<STATUS>",
            "<CODE>0",
            "<SEVERITY>INFO",
            "</STATUS>",
            f"<DTSERVER>{now}",
            "<LANGUAGE>ENG",
        ]
    )

    if fi_org or fi_fid:
        lines.append("<FI>")
        if fi_org:
            lines.append(f"<ORG>{safe_sgml_text(fi_org)}")
        if fi_fid:
            lines.append(f"<FID>{safe_sgml_text(fi_fid)}")
        lines.append("</FI>")
    if intu_bid:
        lines.append(f"<INTU.BID>{safe_sgml_text(intu_bid)}")

    lines.extend(
        [
            "</SONRS>",
            "</SIGNONMSGSRSV1>",
            "<INVSTMTMSGSRSV1>",
            "<INVSTMTTRNRS>",
            "<TRNUID>1",
            "<STATUS>",
            "<CODE>0",
            "<SEVERITY>INFO",
            "</STATUS>",
            "<INVSTMTRS>",
            "<DTASOF>" + now,
            "<CURDEF>USD",
            "<INVACCTFROM>",
            f"<BROKERID>{broker_id}",
            f"<ACCTID>{account_id}",
            "</INVACCTFROM>",
            "<INVTRANLIST>",
            f"<DTSTART>{dt_start}",
            f"<DTEND>{dt_end}",
        ]
    )

    for idx, t in enumerate(trades_sorted, start=1):
        txn_tag = "BUYSTOCK" if t.action == "Buy" else "SELLSTOCK"
        total = calc_total_for_ofx(t, separate_sell_expenses=True)
        total_places = trade_total_places(t)
        commission = Decimal("0") if t.action == "Sell" else abs(t.commission)
        fees = Decimal("0") if t.action == "Sell" else fee_total(t)
        memo = safe_sgml_text(
            f"{t.source_file}; qty={t.quantity}; unit_price={t.unit_price}; principal={t.principal_amount}; net={t.net_amount}; fees={fee_summary(t)}"
        )

        lines.extend(
            [
                f"<{txn_tag}>",
                "<INVBUY>" if t.action == "Buy" else "<INVSELL>",
                "<INVTRAN>",
                f"<FITID>{make_fitid(t, idx)}",
                f"<DTTRADE>{ofx_date(t.trade_date)}",
                f"<DTSETTLE>{ofx_date(t.settle_date)}",
                f"<MEMO>{memo}",
                "</INVTRAN>",
                "<SECID>",
                f"<UNIQUEID>{t.symbol}",
                "<UNIQUEIDTYPE>TICKER",
                "</SECID>",
                f"<UNITS>{dec_str(t.quantity)}",
                f"<UNITPRICE>{dec_str(t.unit_price)}",
                f"<TOTAL>{dec_str(total, total_places)}",
                "<SUBACCTSEC>CASH",
                "<SUBACCTFUND>CASH",
                f"<COMMISSION>{dec_str(commission, 2)}",
                f"<FEES>{dec_str(fees, 2)}",
                "</INVBUY>" if t.action == "Buy" else "</INVSELL>",
                "<BUYTYPE>BUY" if t.action == "Buy" else "<SELLTYPE>SELL",
                f"</{txn_tag}>",
            ]
        )

        if t.action == "Sell":
            for fee_index, fee in enumerate(trade_fee_lines(t), start=1):
                fee_memo_text = safe_sgml_text(fee_memo(t, fee))
                lines.extend(
                    [
                        "<INVEXPENSE>",
                        "<INVTRAN>",
                        f"<FITID>{make_fee_fitid(t, idx, fee_index, fee)}",
                        f"<DTTRADE>{ofx_date(t.trade_date)}",
                        f"<DTSETTLE>{ofx_date(t.settle_date)}",
                        f"<MEMO>{fee_memo_text}",
                        "</INVTRAN>",
                        "<SECID>",
                        f"<UNIQUEID>{t.symbol}",
                        "<UNIQUEIDTYPE>TICKER",
                        "</SECID>",
                        f"<TOTAL>{dec_str(-abs(fee.amount), 2)}",
                        "<SUBACCTSEC>CASH",
                        "<SUBACCTFUND>CASH",
                        "</INVEXPENSE>",
                    ]
                )

    lines.append("</INVTRANLIST>")
    lines.append("<INVPOSLIST>")
    for symbol, (units, unit_price) in sorted(positions.items()):
        if units == 0:
            continue
        pos_type = "LONG" if units > 0 else "SHORT"
        abs_units = abs(units)
        mktval = abs_units * unit_price
        lines.extend(
            [
                "<POSSTOCK>",
                "<INVPOS>",
                "<SECID>",
                f"<UNIQUEID>{symbol}",
                "<UNIQUEIDTYPE>TICKER",
                "</SECID>",
                "<HELDINACCT>CASH",
                f"<POSTYPE>{pos_type}",
                f"<UNITS>{dec_str(abs_units)}",
                f"<UNITPRICE>{dec_str(unit_price)}",
                f"<MKTVAL>{dec_str(mktval, 2)}",
                f"<DTPRICEASOF>{dt_end}",
                "</INVPOS>",
                "</POSSTOCK>",
            ]
        )
    lines.append("</INVPOSLIST>")

    lines.extend(
        [
            "<INVBAL>",
            "<AVAILCASH>0",
            "<MARGINBALANCE>0",
            "<SHORTBALANCE>0",
            "</INVBAL>",
            "</INVSTMTRS>",
            "</INVSTMTTRNRS>",
            "</INVSTMTMSGSRSV1>",
            "<SECLISTMSGSRSV1>",
            "<SECLIST>",
        ]
    )

    for symbol, sec_name in sorted(symbols.items()):
        lines.extend(
            [
                "<STOCKINFO>",
                "<SECINFO>",
                "<SECID>",
                f"<UNIQUEID>{symbol}",
                "<UNIQUEIDTYPE>TICKER",
                "</SECID>",
                f"<SECNAME>{symbol}",
                f"<MEMO>{safe_sgml_text(sec_name)}",
                f"<TICKER>{symbol}",
                "</SECINFO>",
                "</STOCKINFO>",
            ]
        )

    lines.extend(["</SECLIST>", "</SECLISTMSGSRSV1>", "</OFX>"])
    return "\n".join(lines) + "\n"


def build_ofx_23_xml(
    account_id: str,
    trades: list[Trade],
    broker_id: str,
    fi_org: str | None = None,
    fi_fid: str | None = None,
) -> str:
    if not trades:
        raise ValueError("No trades provided")

    trades_sorted = sorted(trades, key=lambda t: (t.trade_date, t.source_file, t.symbol))
    dt_start = ofx_date(min(t.trade_date for t in trades_sorted))
    dt_end = ofx_date(max(t.trade_date for t in trades_sorted))
    now = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")

    symbols: dict[str, str] = {}
    for t in trades_sorted:
        symbols[t.symbol] = t.security_name
    positions = summarize_positions(trades_sorted)

    ofx = ET.Element("OFX")

    signon = ET.SubElement(ofx, "SIGNONMSGSRSV1")
    sonrs_wrap = ET.SubElement(signon, "SONRS")
    status = ET.SubElement(sonrs_wrap, "STATUS")
    append_text(status, "CODE", "0")
    append_text(status, "SEVERITY", "INFO")
    append_text(sonrs_wrap, "DTSERVER", now)
    append_text(sonrs_wrap, "LANGUAGE", "ENG")
    if fi_org or fi_fid:
        fi = ET.SubElement(sonrs_wrap, "FI")
        if fi_org:
            append_text(fi, "ORG", fi_org)
        if fi_fid:
            append_text(fi, "FID", fi_fid)

    inv_msgs = ET.SubElement(ofx, "INVSTMTMSGSRSV1")
    inv_trnrs = ET.SubElement(inv_msgs, "INVSTMTTRNRS")
    append_text(inv_trnrs, "TRNUID", "1")
    trn_status = ET.SubElement(inv_trnrs, "STATUS")
    append_text(trn_status, "CODE", "0")
    append_text(trn_status, "SEVERITY", "INFO")

    invstmtrs = ET.SubElement(inv_trnrs, "INVSTMTRS")
    append_text(invstmtrs, "DTASOF", now)
    append_text(invstmtrs, "CURDEF", "USD")

    invacct = ET.SubElement(invstmtrs, "INVACCTFROM")
    append_text(invacct, "BROKERID", broker_id)
    append_text(invacct, "ACCTID", account_id)

    invtranlist = ET.SubElement(invstmtrs, "INVTRANLIST")
    append_text(invtranlist, "DTSTART", dt_start)
    append_text(invtranlist, "DTEND", dt_end)

    for idx, t in enumerate(trades_sorted, start=1):
        txn_node = ET.SubElement(invtranlist, "BUYSTOCK" if t.action == "Buy" else "SELLSTOCK")
        side = ET.SubElement(txn_node, "INVBUY" if t.action == "Buy" else "INVSELL")

        invtran = ET.SubElement(side, "INVTRAN")
        append_text(invtran, "FITID", make_fitid(t, idx))
        append_text(invtran, "DTTRADE", ofx_date(t.trade_date))
        append_text(invtran, "DTSETTLE", ofx_date(t.settle_date))
        memo = (
            f"{t.source_file}; qty={t.quantity}; unit_price={t.unit_price}; principal={t.principal_amount}; "
            f"net={t.net_amount}; fees={fee_summary(t)}"
        )
        append_text(invtran, "MEMO", memo)

        secid = ET.SubElement(side, "SECID")
        append_text(secid, "UNIQUEID", t.symbol)
        append_text(secid, "UNIQUEIDTYPE", "TICKER")

        total_places = trade_total_places(t)
        append_text(side, "UNITS", dec_str(t.quantity))
        append_text(side, "UNITPRICE", dec_str(t.unit_price))
        append_text(side, "TOTAL", dec_str(calc_total_for_ofx(t, separate_sell_expenses=True), total_places))
        append_text(side, "SUBACCTSEC", "CASH")
        append_text(side, "SUBACCTFUND", "CASH")
        append_text(side, "COMMISSION", dec_str(Decimal("0") if t.action == "Sell" else abs(t.commission), 2))
        append_text(side, "FEES", dec_str(Decimal("0") if t.action == "Sell" else fee_total(t), 2))
        append_text(txn_node, "BUYTYPE" if t.action == "Buy" else "SELLTYPE", t.action.upper())

        if t.action == "Sell":
            for fee_index, fee in enumerate(trade_fee_lines(t), start=1):
                expense = ET.SubElement(invtranlist, "INVEXPENSE")
                invtran_fee = ET.SubElement(expense, "INVTRAN")
                append_text(invtran_fee, "FITID", make_fee_fitid(t, idx, fee_index, fee))
                append_text(invtran_fee, "DTTRADE", ofx_date(t.trade_date))
                append_text(invtran_fee, "DTSETTLE", ofx_date(t.settle_date))
                append_text(invtran_fee, "MEMO", fee_memo(t, fee))

                secid_fee = ET.SubElement(expense, "SECID")
                append_text(secid_fee, "UNIQUEID", t.symbol)
                append_text(secid_fee, "UNIQUEIDTYPE", "TICKER")

                append_text(expense, "TOTAL", dec_str(-abs(fee.amount), 2))
                append_text(expense, "SUBACCTSEC", "CASH")
                append_text(expense, "SUBACCTFUND", "CASH")

    invposlist = ET.SubElement(invstmtrs, "INVPOSLIST")
    for symbol, (units, unit_price) in sorted(positions.items()):
        if units == 0:
            continue
        pos_type = "LONG" if units > 0 else "SHORT"
        abs_units = abs(units)
        posstock = ET.SubElement(invposlist, "POSSTOCK")
        invpos = ET.SubElement(posstock, "INVPOS")
        secid = ET.SubElement(invpos, "SECID")
        append_text(secid, "UNIQUEID", symbol)
        append_text(secid, "UNIQUEIDTYPE", "TICKER")
        append_text(invpos, "HELDINACCT", "CASH")
        append_text(invpos, "POSTYPE", pos_type)
        append_text(invpos, "UNITS", dec_str(abs_units))
        append_text(invpos, "UNITPRICE", dec_str(unit_price))
        append_text(invpos, "MKTVAL", dec_str(abs_units * unit_price, 2))
        append_text(invpos, "DTPRICEASOF", dt_end)

    invbal = ET.SubElement(invstmtrs, "INVBAL")
    append_text(invbal, "AVAILCASH", "0")
    append_text(invbal, "MARGINBALANCE", "0")
    append_text(invbal, "SHORTBALANCE", "0")

    seclist_msgs = ET.SubElement(ofx, "SECLISTMSGSRSV1")
    seclist = ET.SubElement(seclist_msgs, "SECLIST")
    for symbol, sec_name in sorted(symbols.items()):
        stockinfo = ET.SubElement(seclist, "STOCKINFO")
        secinfo = ET.SubElement(stockinfo, "SECINFO")
        secid = ET.SubElement(secinfo, "SECID")
        append_text(secid, "UNIQUEID", symbol)
        append_text(secid, "UNIQUEIDTYPE", "TICKER")
        append_text(secinfo, "SECNAME", symbol)
        append_text(secinfo, "MEMO", sec_name)
        append_text(secinfo, "TICKER", symbol)

    ET.indent(ofx, space="  ")
    xml_body = ET.tostring(ofx, encoding="unicode")
    xml_decl = '<?xml version="1.0" encoding="UTF-8"?>\n'
    ofx_pi = '<?OFX OFXHEADER="200" VERSION="203" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n'
    return xml_decl + ofx_pi + xml_body + "\n"


def group_by_account(trades: Iterable[Trade]) -> dict[str, list[Trade]]:
    grouped: dict[str, list[Trade]] = {}
    for t in trades:
        grouped.setdefault(t.account_id, []).append(t)
    return grouped


def sanitize_account_for_filename(account_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", account_id)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Convert Aliena confirmation PDFs to OFX investment files"
    )
    parser.add_argument(
        "pdfs",
        nargs="*",
        help="Specific PDF files to convert (overrides --input-dir/--glob)",
    )
    parser.add_argument("--input-dir", default=".", help="Directory containing PDF files")
    parser.add_argument("--glob", default="Confirm_*.pdf", help="Glob pattern for PDFs")
    parser.add_argument("--output-dir", default="ofx_output", help="Output folder for OFX files")
    parser.add_argument(
        "--broker-id",
        default="drivewealth.com",
        help="OFX BROKERID value (default: drivewealth.com)",
    )
    parser.add_argument(
        "--ofx-version",
        choices=["1.0.2", "2.3"],
        default="2.3",
        help="Output OFX dialect: 2.3 XML or 1.0.2 SGML (default: 2.3)",
    )
    parser.add_argument(
        "--intu-bid",
        default="",
        help="Optional Intuit BID header for Quicken/QFX compatibility",
    )
    parser.add_argument(
        "--quicken-mode",
        action="store_true",
        help="Force Quicken-friendly output: OFX 1.0.2 + .qfx copy (no INTU.BID unless provided)",
    )
    parser.add_argument(
        "--quicken-investment-mode",
        action="store_true",
        help="Force Quicken investment profile: OFX 1.0.2 + .qfx + BID/FI preset for investment service",
    )
    parser.add_argument(
        "--fi-org",
        default="",
        help="Optional FI/ORG value for SONRS metadata",
    )
    parser.add_argument(
        "--fi-fid",
        default="",
        help="Optional FI/FID value for SONRS metadata",
    )
    parser.add_argument(
        "--numeric-acctid",
        action="store_true",
        help="Normalize ACCTID to mostly numeric form (recommended for Quicken)",
    )
    args = parser.parse_args()

    if args.quicken_mode or args.quicken_investment_mode:
        args.quicken_mode = True
        args.ofx_version = "1.0.2"
        args.numeric_acctid = True
        if args.quicken_investment_mode:
            if not args.intu_bid:
                args.intu_bid = "9999"
            if not args.fi_org:
                args.fi_org = "Intuit"
            if not args.fi_fid:
                args.fi_fid = "9999"
        else:
            if not args.fi_org:
                args.fi_org = "DriveWealth"
            if not args.fi_fid:
                args.fi_fid = "00000"

    if args.pdfs:
        pdf_paths = sorted(Path(p) for p in args.pdfs)
        missing = [p for p in pdf_paths if not p.is_file()]
        if missing:
            raise SystemExit(f"PDF not found: {missing[0]}")
    else:
        input_dir = Path(args.input_dir)
        pdf_paths = sorted(input_dir.glob(args.glob))
        if not pdf_paths:
            raise SystemExit(f"No PDFs found matching {args.glob} in {input_dir}")

    all_trades: list[Trade] = []
    for pdf_path in pdf_paths:
        all_trades.extend(parse_trades_from_pdf(pdf_path))

    if not all_trades:
        raise SystemExit("No trades parsed from PDFs")

    grouped = group_by_account(all_trades)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    run_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    for account_id, trades in sorted(grouped.items()):
        acctid_out = normalize_account_id_for_quicken(account_id) if args.numeric_acctid else account_id
        base_name = sanitize_account_for_filename(account_id)

        if args.ofx_version == "2.3":
            ofx_text = build_ofx_23_xml(
                acctid_out,
                trades,
                args.broker_id,
                args.fi_org or None,
                args.fi_fid or None,
            )
        else:
            ofx_text = build_ofx(
                acctid_out,
                trades,
                args.broker_id,
                args.intu_bid or None,
                args.fi_org or None,
                args.fi_fid or None,
            )
        output_file = output_dir / f"{base_name}_{run_timestamp}.ofx"
        encoding = "utf-8" if args.ofx_version == "2.3" else "ascii"
        output_file.write_text(ofx_text, encoding=encoding, errors="ignore")
        if args.quicken_mode:
            qfx_file = output_dir / f"{base_name}_{run_timestamp}.qfx"
            qfx_file.write_text(ofx_text, encoding=encoding, errors="ignore")
            print(f"Wrote {qfx_file} ({len(trades)} trades)")
        print(f"Wrote {output_file} ({len(trades)} trades)")

    print(f"Parsed {len(all_trades)} trades across {len(grouped)} account(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

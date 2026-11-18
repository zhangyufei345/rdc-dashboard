# -*- coding: utf-8 -*-
"""
山姆前置仓「实际在库 + 在途」数据构建器（v513，2026-11-18 用户裁定）

【用户口径】
  1. 天津：用户给定 2026-10-18 期末库存 = 27,840 箱（明确纠正过不是 11-18）。
  2. 其他仓：不给单独期初 ——「首次转储量在运输周期后就可以认为是期初库存」。
     落地：该仓第一笔转储的「到仓日」= 创建日期 + 运输时效，当天期初在库 = 第一笔转储量；
     到仓日之前无库存数据，图上留白（不画 0，避免假装知道）。
  3. 运输时效按用户 2026-11-18 裁定：表里「1+4」的 1 是下单当日（T），不额外加；
     到仓日 = 创建日期 + 提货运输天数。天津 4 / 惠州 4 / 嘉兴 2 / 武汉 4 / 成都 5 天。
     ⚠ 与页面模拟公式 SAMS_LEAD（1+4=5 天）差 1 天：那个是 ROP 计算用的「下单→到仓」口径，
     本文件是真实转储到仓回放，按用户明确裁定的 T+4。
  4. 转储量取 V 列「发货过账数量」（武汉首车 V=5568、T=0，即 11/18 发出、11/22 到仓）。
  5. 逐日实际出货取 sams-sim-data.json 的 daily[].ship（同源切片差分，末日 2026-11-17）；
     出货已知的末日之后 ship 记 null，只推进在途/到仓，不假造出货。
  6. Sheet2 的 SMWH→山姆惠州 与 SMHZ 重复，是源表笔误；只在读取层改为 SMWH→武汉，不改源文件。

【产出】sams-actual-stock.json（静态文件，不进 manifest，靠 ?t= 破缓存）
"""
import os
import sys
import json
import datetime
import collections

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_XLSX = r"C:/Users/zhangyufei1/Desktop/山姆转储.XLSX"
SRC_SIM = os.path.join(ROOT, 'sams-sim-data.json')
OUT = os.path.join(ROOT, 'sams-actual-stock.json')

SKU = '69001'
START = '2026-10-18'
LEAD = {'天津': 4, '惠州': 4, '嘉兴': 2, '武汉': 4, '成都': 5, '常州': 0}   # v514：用户裁定取「提货运输」天数（1+4→4），T 当日不额外加
TJ_OPENING = 27840                      # 天津 2026-10-18 期末库存（用户给定）
# 读取层修正：Sheet2 把 SMWH 写成山姆惠州（与 SMHZ 撞仓），按用户裁定改为武汉
WH_MAP = {'SMTJ': '天津', 'SMHZ': '惠州', 'SMJX': '嘉兴',
          'SMWH': '武汉', 'SMCD': '成都', 'SMCZ': '常州'}
DAY = datetime.timedelta(days=1)


def d(s):
    return datetime.date.fromisoformat(s)


def iso(dt):
    return dt.isoformat()


def norm_date(v):
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    return str(v).strip()[:10].replace('/', '-')


def num(v):
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def read_transfers(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    if 'Sheet1' not in wb.sheetnames:
        raise SystemExit('转储文件缺 Sheet1')
    rows = list(wb['Sheet1'].iter_rows(values_only=True))
    hdr = [str(x or '').strip() for x in rows[0]]
    i_date, i_wh = 1, 3
    i_in, i_post = 19, 21
    assert '创建日期' in hdr and '收货库位' in hdr, '表头不符合预期: %s' % hdr[:5]
    assert '入库数量' in hdr and '发货过账数量' in hdr, '缺入库/发货过账列: %s' % hdr
    i_date = hdr.index('创建日期')
    i_wh = hdr.index('收货库位')
    i_in = hdr.index('入库数量')
    i_post = hdr.index('发货过账数量')
    i_po = hdr.index('采购凭证') if '采购凭证' in hdr else None
    out, bad = [], []
    for r in rows[1:]:
        code = str(r[i_wh] or '').strip()
        dt = norm_date(r[i_date])
        if not code or not dt or dt < START:
            continue
        w = WH_MAP.get(code)
        if not w:
            bad.append((code, dt))
            continue
        qty = num(r[i_post])
        if qty <= 0:
            continue
        out.append({
            'date': dt,
            'wh': w,
            'code': code,
            'qty': qty,
            'receipt': num(r[i_in]),
            'po': str(r[i_po] or '') if i_po is not None else '',
            'arrivalDate': iso(d(dt) + datetime.timedelta(days=LEAD[w])),
        })
    if bad:
        print('⚠ 未识别库位（已跳过）:', bad)
    out.sort(key=lambda x: (x['date'], x['wh']))
    return out


def build():
    transfers = read_transfers(SRC_XLSX)
    sim = json.load(open(SRC_SIM, encoding='utf-8'))
    daily_src = sim['daily']
    ship_last = daily_src[-1]['date']
    ship_known = {x['date']: True for x in daily_src}
    ship_by_wh = {x['date']: {w: num(x['ship'].get(w)) for w in LEAD} for x in daily_src}

    prefer = ['天津', '惠州', '嘉兴', '武汉', '成都', '常州']
    present = set([t['wh'] for t in transfers] + sim['activeWarehouses'])
    active = [w for w in prefer if w in present] + sorted(present - set(prefer))
    end = max([ship_last] + [t['arrivalDate'] for t in transfers])
    dates = []
    cur = d(START)
    while cur <= d(end):
        dates.append(iso(cur))
        cur += DAY

    # 按仓聚合：转储发出量 / 到仓量
    send, arrive = {}, {}
    for t in transfers:
        send.setdefault((t['wh'], t['date']), 0.0)
        send[(t['wh'], t['date'])] += t['qty']
        arrive.setdefault((t['wh'], t['arrivalDate']), 0.0)
        arrive[(t['wh'], t['arrivalDate'])] += t['qty']

    per = {}
    notes = {}
    for w in active:
        wh_trans = [t for t in transfers if t['wh'] == w]
        first_arr = min((t['arrivalDate'] for t in wh_trans), default=None)
        opening_date = START if w == '天津' else first_arr
        opening_qty = TJ_OPENING if w == '天津' else (
            sum(t['qty'] for t in wh_trans if t['arrivalDate'] == first_arr) if first_arr else None)

        rows, on_hand = [], None
        for dt in dates:
            ar = arrive.get((w, dt), 0.0)
            sd = send.get((w, dt), 0.0)
            transit = sum(q for (ww, s), q in send.items()
                          if ww == w and s <= dt < iso(d(s) + datetime.timedelta(days=LEAD[w])))
            ship = ship_by_wh.get(dt, {}).get(w) if ship_known.get(dt) else None

            if dt == opening_date:
                on_hand = opening_qty
            elif on_hand is not None:
                on_hand += ar - (ship or 0)
                if on_hand < 0:
                    on_hand = 0

            rows.append({
                'date': dt,
                'onHand': None if on_hand is None else round(on_hand, 2),
                'transit': round(transit, 2),
                'invPos': None if on_hand is None else round(on_hand + transit, 2),
                'arrival': round(ar, 2),
                'transfer': round(sd, 2),
                'ship': None if ship is None else round(ship, 2),
                'opening': dt == opening_date,
                'shipKnown': bool(ship_known.get(dt)),
            })
        per[w] = rows
        notes[w] = {
            'openingDate': opening_date,
            'openingQty': None if opening_qty is None else round(opening_qty, 2),
            'openingSource': ('用户给定 2026-10-18 期末库存 27,840 箱' if w == '天津'
                              else '首次转储量于到仓日作为期初（创建日+%d 天）' % LEAD[w]),
            'leadDays': LEAD[w],
            'transferTotal': round(sum(t['qty'] for t in wh_trans), 2),
            'transferCount': len(wh_trans),
            'firstTransferDate': wh_trans[0]['date'] if wh_trans else None,
            'firstArrivalDate': first_arr,
        }

    ver = {
        'warehouses': active,
        'transferRows': len(transfers),
        'transferTotalByWh': {w: round(sum(t['qty'] for t in transfers if t['wh'] == w), 2) for w in active},
        'shipTotalByWh': {w: round(sum(num(x['ship'].get(w)) for x in daily_src), 2) for w in active},
        'shipKnownThrough': ship_last,
        'dateRange': [START, end],
        'smwhCorrected': True,
    }
    assert ver['transferTotalByWh'].get('武汉') == 5568, '武汉首车应为 5,568 箱'
    assert all(ver['transferTotalByWh'].get(w, 0) > 0 for w in ['天津', '惠州', '嘉兴', '武汉'])

    obj = {
        'generatedAt': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'sourceXlsx': os.path.basename(SRC_XLSX),
        'sourceSim': os.path.basename(SRC_SIM),
        'sku': SKU,
        'unit': '箱',
        'warehouses': active,
        'dateRange': [START, end],
        'leadDays': LEAD,
        'notes': notes,
        'daily': per,
        'transfers': transfers,
        'verification': ver,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    print('已写出', OUT, os.path.getsize(OUT), '字节')
    print(json.dumps(ver, ensure_ascii=False, indent=2))
    print('\n逐仓期初 / 首车 / 末值:')
    for w in active:
        rows = [r for r in per[w] if r['onHand'] is not None]
        print('  %s 期初 %s@%s | 首车 %s 到仓 %s | 末在库 %s 末在途 %s | 有效 %d 天'
              % (w, notes[w]['openingQty'], notes[w]['openingDate'],
                 notes[w]['firstTransferDate'], notes[w]['firstArrivalDate'],
                 rows[-1]['onHand'] if rows else None, per[w][-1]['transit'], len(rows)))


if __name__ == '__main__':
    build()

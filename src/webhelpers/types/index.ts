export type Exchange = 'binance' | 'bybit' | 'kucoin' | 'okx' | 'backpack';

export type BinanceMiniTicker = {
    e: string; // Event type
    E: number; // Event time
    s: string; // Symbol
    c: string; // Close price
    o: string; // Open price
    h: string; // High price
    l: string; // Low price
    v: string; // Total traded base asset volume
    q: string; // Total traded quote asset volume
}

export type priceData = {
  ticker: string,
  price?: number,
  orders?: Orders
}

export type Order = {price:number, size:number}
export type Orders = {bid:Order[], ask:Order[], lastUpdateId?:number}
export type tickerData = {price:number | undefined, lastUpdated:number, orders:Orders}

export type OkxMarkPrice = {
    arg: { channel: string, instId: string },
    data: [
      {
        instId: string;
        instType: string;
        markPx: string;
        ts: string;
      }
    ]
  }
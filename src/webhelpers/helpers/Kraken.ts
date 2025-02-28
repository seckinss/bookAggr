import { Exchange } from "./Exchange";
import { tickerData, Order, priceData, KrakenTickerConfig, KrakenBookSnapshot, KrakenBookUpdate } from "../types";
import { KRAKEN_WS_URL } from '../constants';


export class Kraken extends Exchange {
    protected name: string = 'KRAKEN';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: KrakenTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = KRAKEN_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 100; // Number of order book levels to maintain
    protected orderBooks: Map<string, { bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();

    constructor(tickerConfigs: KrakenTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        if (typeof tickerConfigs[0] === 'string') {
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as KrakenTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = this.createTicker(config.ticker);
            
            if (config.trackPrice !== false) {
                this.trackingPrice.add(formattedTicker);
            }
            
            if (config.trackOrderBook === true) {
                this.trackingOrderBook.add(formattedTicker);
            }
            
            return formattedTicker;
        });
    }

    public async start(): Promise<void> {
        await this.connect();
    }

    protected onMessage = (event: MessageEvent): priceData | null => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.channel === 'book' && data.type === 'snapshot') {
                const bookData = data as KrakenBookSnapshot;
                const symbol = bookData.data[0].symbol;
                const ticker = this.parseTicker(symbol);
                
                if (this.trackingOrderBook.has(symbol)) {
                    this.processBookSnapshot(bookData);
                }
                return null;
            }
            
            if (data.channel === 'book' && data.type === 'update') {
                const bookData = data as KrakenBookUpdate;
                const symbol = bookData.data[0].symbol;
                
                if (this.trackingOrderBook.has(symbol)) {
                    this.processBookUpdate(bookData);
                }
                return null;
            }
            
            
            return null;
        } catch (error) {
            console.error(`${this.name} error parsing message:`, error);
            return null;
        }
    };

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        const bookSubscriptions: string[] = [];
        
        tickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                bookSubscriptions.push(ticker);
            }
        });
        
        if (bookSubscriptions.length > 0) {
            const subscribePayload = JSON.stringify({
                method: "subscribe",
                params: {
                    channel: "book",
                    symbol: bookSubscriptions,
                    depth: this.orderBookDepth,
                    snapshot: true
                }
            });
            ws.send(subscribePayload);
        }
        
        tickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                this.initializeOrderBook(ticker);
            }
        });
    };

    protected parseTicker = (ticker: string): string => {
        return ticker.split('/')[0];
    };

    protected createTicker = (ticker: string): string => {
        return `${ticker}/USD`;
    };

    protected processBookSnapshot(data: KrakenBookSnapshot): void {
        const bookData = data.data[0];
        const symbol = bookData.symbol;
        const ticker = this.parseTicker(symbol);
        
        const bids = new Map<number, number>();
        const asks = new Map<number, number>();
        
        bookData.bids.forEach(bid => {
            bids.set(bid.price, bid.qty);
        });
        
        bookData.asks.forEach(ask => {
            asks.set(ask.price, ask.qty);
        });
        
        this.orderBooks.set(symbol, { bids, asks });
        
        this.updatePricesOrderBook(symbol);
    }

    protected processBookUpdate(data: KrakenBookUpdate): void {
        const bookData = data.data[0];
        const symbol = bookData.symbol;
        
        const orderBook = this.orderBooks.get(symbol);
        if (!orderBook) return;
        
        bookData.bids.forEach(bid => {
            if (bid.qty === 0) {
                orderBook.bids.delete(bid.price);
            } else {
                orderBook.bids.set(bid.price, bid.qty);
            }
        });
        
        bookData.asks.forEach(ask => {
            if (ask.qty === 0) {
                orderBook.asks.delete(ask.price);
            } else {
                orderBook.asks.set(ask.price, ask.qty);
            }
        });
        
        this.updatePricesOrderBook(symbol);
    }

    protected async initializeOrderBook(ticker: string): Promise<void> {
        try {
            if (!this.orderBooks.has(ticker)) {
                this.orderBooks.set(ticker, {
                    bids: new Map<number, number>(),
                    asks: new Map<number, number>()
                });
            }
        } catch (error) {
            console.error(`${this.name}: Error initializing order book for ${ticker}:`, error);
        }
    }

    protected updatePricesOrderBook(symbol: string): void {
        const orderBook = this.orderBooks.get(symbol);
        if (!orderBook) return;
        
        const ticker = this.parseTicker(symbol);
        const currentData = this.prices.get(ticker) || {
            price: undefined,
            lastUpdated: 0,
            orders: { bid: [], ask: [] }
        };
        
        const bids: Order[] = Array.from(orderBook.bids.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price)
            .slice(0, this.orderBookDepth);
        
        const asks: Order[] = Array.from(orderBook.asks.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price)
            .slice(0, this.orderBookDepth);
        
        this.prices.set(ticker, {
            price: currentData.price,
            lastUpdated: Date.now(),
            orders: {
                bid: bids,
                ask: asks
            }
        });
    }

    public async connect(): Promise<void> {
        if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.ws = new WebSocket(this.wsURL);
        }
        
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => {
                if (!this.isClosing) {
                    this.subscribe(this.formattedTickers);
                }
                resolve();
            };
            
            this.ws.onmessage = (event) => {
                this.onMessage(event);
            };
            
            this.ws.onerror = (error) => {
                console.error(`${this.name} WS error:`, error);
                reject(error);
            };
            
            this.ws.onclose = (event) => {
                if (!this.isClosing && event.code !== 1000) {
                    setTimeout(() => this.start(), 5000); // Reconnect after 5 seconds
                }
            };
        });
    }

    public close(): void {
        this.isClosing = true;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const unsubscribePayload = JSON.stringify({
                method: "unsubscribe",
                params: {
                    channel: "book",
                    symbol: this.formattedTickers
                }
            });
            this.ws.send(unsubscribePayload);
            this.ws.close(1000, 'Closing connection');
        }
    }

    public async changeTickers(newTickerConfigs: KrakenTickerConfig[] | string[]): Promise<void> {
        try {
            await this.unsubscribeAll();
            
            if (typeof newTickerConfigs[0] === 'string') {
                this.tickerConfigs = (newTickerConfigs as string[]).map(ticker => ({
                    ticker,
                    trackPrice: true,
                    trackOrderBook: true
                }));
                this.tickers = newTickerConfigs as string[];
            } else {
                this.tickerConfigs = newTickerConfigs as KrakenTickerConfig[];
                this.tickers = this.tickerConfigs.map(config => config.ticker);
            }
            
            this.trackingOrderBook.clear();
            this.trackingPrice.clear();
            
            this.formattedTickers = this.tickerConfigs.map(config => {
                const formattedTicker = this.createTicker(config.ticker);
                
                if (config.trackPrice !== false) {
                    this.trackingPrice.add(formattedTicker);
                }
                
                if (config.trackOrderBook === true) {
                    this.trackingOrderBook.add(formattedTicker);
                }
                
                return formattedTicker;
            });
            
            if (this.ws.readyState === WebSocket.OPEN) {
                this.subscribe(this.formattedTickers);
            } else {
                console.error(`${this.name}: WebSocket not open, reconnecting...`);
                await this.start();
            }
        } catch (error) {
            console.error(`${this.name}: Error changing tickers:`, error);
            throw error;
        }
    }

    protected async unsubscribeAll(): Promise<void> {
        if (this.ws.readyState !== WebSocket.OPEN) {
            console.error(`${this.name}: WebSocket not open, cannot unsubscribe`);
            return;
        }
        
        if (this.formattedTickers.length > 0) {
            const unsubscribePayload = JSON.stringify({
                method: "unsubscribe",
                params: {
                    channel: "book",
                    symbol: this.formattedTickers
                }
            });
            this.ws.send(unsubscribePayload);
        }
        
        this.prices.clear();
        this.orderBooks.clear();
    }
}

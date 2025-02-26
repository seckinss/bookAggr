import { Exchange } from "./Exchange";
import { tickerData, Order, priceData } from "../types";
import { OKX_WS_URL } from '../constants';
import axios from 'axios';

interface OkxDepthUpdate {
    arg: {
        channel: string;
        instId: string;
    };
    action: string;
    data: Array<{
        asks: string[][];
        bids: string[][];
        ts: string;
        checksum?: number;
    }>;
}

export interface OKXTickerConfig {
    ticker: string;
    trackPrice?: boolean;
    trackOrderBook?: boolean;
}

export class OKX extends Exchange {
    protected name: string = 'OKX';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: OKXTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = OKX_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 20; // Number of order book levels to maintain
    protected orderBooks: Map<string, { lastUpdateId: number, bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected isInitializing: Map<string, boolean> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();

    constructor(tickerConfigs: OKXTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        // Handle both string[] and OKXTickerConfig[] inputs
        if (typeof tickerConfigs[0] === 'string') {
            // If string array, assume tracking both price and order book
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as OKXTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}-USDT`;
            
            // Default to true if not specified
            if (config.trackPrice !== false) {
                this.trackingPrice.add(formattedTicker);
            }
            
            if (config.trackOrderBook === true) {
                this.trackingOrderBook.add(formattedTicker);
                // Initialize flags only for tickers that need order book tracking
                this.isInitializing.set(formattedTicker, true);
            }
            
            return formattedTicker;
        });
    }

    public async start(): Promise<void> {
        await this.connect();
    }

    protected onMessage = (message: MessageEvent): priceData | null => {
        const data = JSON.parse(message.data);
        
        if (data.ping) {
            this.ws.send(JSON.stringify({ pong: data.ping }));
            return null;
        }
        // Handle price updates
        if (data.arg && data.arg.channel === 'mark-price' && !data.event) {
            const ticker = data.arg.instId;
            // Only process price updates for tickers we're tracking prices for
            if (this.trackingPrice.has(ticker)) {
                return { ticker, price: parseFloat(data.data[0].markPx) };
            }
        } 
        // Handle order book updates
        else if (data.arg && data.arg.channel === 'books' && !data.event) {
            const ticker = data.arg.instId;
            // Only process order book updates for tickers we're tracking order books for
            if (this.trackingOrderBook.has(ticker)) {
                this.processOrderBookUpdate(data as OkxDepthUpdate);
            }
        }
        return null;
    };

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        const subscriptionArgs: any[] = [];
        
        // Add price and order book subscriptions only for tickers that need them
        tickers.forEach(ticker => {
            if (this.trackingPrice.has(ticker)) {
                subscriptionArgs.push({ channel: 'mark-price', instId: ticker });
            }
            
            if (this.trackingOrderBook.has(ticker)) {
                subscriptionArgs.push({ channel: 'books', instId: ticker });
            }
        });
        
        if (subscriptionArgs.length > 0) {
            const subscribePayload = JSON.stringify({
                op: 'subscribe',
                args: subscriptionArgs
            });
            ws.send(subscribePayload);
        }
        
        // Initialize order books after subscription, but only for tickers tracking order books
        tickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                this.initializeOrderBook(ticker);
            }
        });
    };

    protected parseTicker = (ticker: string): string => ticker.replace('-USDT', '');

    protected createTicker = (ticker: string): string => `${ticker}-USDT`;

    /**
     * Process order book updates from WebSocket
     */
    protected processOrderBookUpdate(data: OkxDepthUpdate): void {
        const ticker = data.arg.instId;
        
        // If we're still initializing, skip this update
        if (this.isInitializing.get(ticker)) {
            return;
        }
        
        // Get the order book data
        const orderBookData = data.data[0];
        
        // Get current order book
        const orderBook = this.orderBooks.get(ticker);
        
        // If we don't have an order book yet, ignore this update
        if (!orderBook) return;
        
        // Process bid updates
        if (orderBookData.bids && orderBookData.bids.length > 0) {
            orderBookData.bids.forEach((bid: string[]) => {
                const price = parseFloat(bid[0]);
                const quantity = parseFloat(bid[1]);
                
                if (quantity === 0) {
                    orderBook.bids.delete(price);
                } else {
                    orderBook.bids.set(price, quantity);
                }
            });
        }
        
        // Process ask updates
        if (orderBookData.asks && orderBookData.asks.length > 0) {
            orderBookData.asks.forEach((ask: string[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                
                if (quantity === 0) {
                    orderBook.asks.delete(price);
                } else {
                    orderBook.asks.set(price, quantity);
                }
            });
        }
        
        // Update lastUpdateId (using timestamp as OKX doesn't provide an update ID)
        orderBook.lastUpdateId = parseInt(orderBookData.ts);
        
        // Update the prices map with the updated order book
        this.updatePricesOrderBook(ticker);
    }

    /**
     * Initialize order book for a ticker
     */
    protected async initializeOrderBook(ticker: string): Promise<void> {
        try {
            // Mark as initializing
            this.isInitializing.set(ticker, true);
            
            // Fetch snapshot from OKX API
            const snapshot = await this.fetchOrderBookSnapshot(ticker);
            
            // Initialize order book with snapshot data
            const bids = new Map<number, number>();
            const asks = new Map<number, number>();
            
            snapshot.bids.forEach((bid: string[]) => {
                const price = parseFloat(bid[0]);
                const quantity = parseFloat(bid[1]);
                if (quantity > 0) {
                    bids.set(price, quantity);
                }
            });
            
            snapshot.asks.forEach((ask: string[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                if (quantity > 0) {
                    asks.set(price, quantity);
                }
            });
            
            // Store the order book data
            this.orderBooks.set(ticker, { 
                lastUpdateId: parseInt(snapshot.ts), 
                bids, 
                asks 
            });
            
            // Update the prices map with the order book data
            this.updatePricesOrderBook(ticker);
            
            // Mark as initialized
            this.isInitializing.set(ticker, false);
            
        } catch (error) {
            console.error(`${this.name}: Error initializing order book for ${ticker}:`, error);
            // Retry after a delay
            setTimeout(() => this.initializeOrderBook(ticker), 5000);
        }
    }

    /**
     * Fetch order book snapshot from OKX REST API
     */
    protected async fetchOrderBookSnapshot(ticker: string): Promise<any> {
        try {
            const response = await axios.get(`https://www.okx.com/api/v5/market/books-full`, {
                params: {
                    instId: ticker
                }
            });
            
            if (response.data && response.data.code === '0' && response.data.data && response.data.data.length > 0) {
                return response.data.data[0];
            } else {
                throw new Error(`Invalid response from OKX API: ${JSON.stringify(response.data)}`);
            }
        } catch (error) {
            console.error(`${this.name}: Error fetching order book snapshot for ${ticker}:`, error);
            throw error;
        }
    }

    /**
     * Update the prices map with current order book data
     */
    protected updatePricesOrderBook(ticker: string): void {
        const orderBook = this.orderBooks.get(ticker);
        if (!orderBook) return;
        
        const parsedTicker = this.parseTicker(ticker);
        const currentData = this.prices.get(parsedTicker) || {
            price: undefined,
            lastUpdated: 0,
            orders: { bid: [], ask: [] }
        };
        
        // Convert bids and asks maps to arrays and sort them
        const bids: Order[] = Array.from(orderBook.bids.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price) // Sort bids in descending order
            .slice(0, this.orderBookDepth); // Limit to specified depth
        
        const asks: Order[] = Array.from(orderBook.asks.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price) // Sort asks in ascending order
            .slice(0, this.orderBookDepth); // Limit to specified depth
        
        // Update the prices map
        this.prices.set(parsedTicker, {
            price: currentData.price,
            lastUpdated: Date.now(),
            orders: {
                bid: bids,
                ask: asks,
                lastUpdateId: orderBook.lastUpdateId
            }
        });
    }

    public async connect(): Promise<void> {
        if(!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.ws = new WebSocket(this.wsURL);
        }
        return new Promise((resolve, reject) => {
        this.ws.onopen = () => {
            if (!this.isClosing) {
                this.subscribe(this.formattedTickers);
                resolve();
            }
        };

        this.ws.onmessage = (message) => {
            const result = this.onMessage(message);
            if (result && result.price !== undefined) {
                const parsedTicker = this.parseTicker(result.ticker);
                const currentData = this.prices.get(parsedTicker) || {
                    price: undefined,
                    lastUpdated: 0,
                    orders: { bid: [], ask: [] }
                };

                this.prices.set(parsedTicker, {
                    price: result.price,
                    lastUpdated: Date.now(),
                    orders: currentData.orders
                });
            }
        };
        this.ws.onerror = (error) => {
            console.error(`${this.name} WS error:`, error);
            reject(error);
        };
        this.ws.onclose = ( event: CloseEvent) => {
            if (!this.isClosing && event.code !== 1013) {
                console.error(`${this.name} WS connection closed with code:`, event.code, 'and reason:', event.reason.toString());
                this.ws = new WebSocket(this.wsURL);
                this.start();
            }
        };
        });
    }

    public close(): void {
        this.isClosing = true;
        this.ws.close(1000, 'Closing connection');
    }
    public async changeTickers(newTickerConfigs: OKXTickerConfig[] | string[]): Promise<void> {
        try {
            await this.unsubscribeAll();
            
        // Update ticker configurations
        if (typeof newTickerConfigs[0] === 'string') {
            this.tickerConfigs = (newTickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = newTickerConfigs as string[];
        } else {
            this.tickerConfigs = newTickerConfigs as OKXTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Clear tracking sets
        this.trackingOrderBook.clear();
        this.trackingPrice.clear();
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}-USDT`;
            
            // Default to true if not specified
            if (config.trackPrice !== false) {
                this.trackingPrice.add(formattedTicker);
            }
            
            if (config.trackOrderBook === true) {
                this.trackingOrderBook.add(formattedTicker);
                // Initialize flags only for tickers that need order book tracking
                this.isInitializing.set(formattedTicker, true);
            }
            
            return formattedTicker;
        });
        
        // Subscribe to new tickers
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
            return;
        }
        
        // Unsubscribe from price updates
        const args: any[] = [];
        if (this.trackingPrice.size > 0) {
            this.trackingPrice.forEach(ticker => {
                args.push({ channel: 'mark-price', instId: ticker });
            });
        }
        
        // Unsubscribe from order book updates
        this.formattedTickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                args.push({ channel: 'books', instId: ticker });
            }
        });
        
        if (args.length > 0) {
            const unsubscribePayload = JSON.stringify({
                op: 'unsubscribe',
                args: args
            });
            this.ws.send(unsubscribePayload);
            
        };
        
        // Clear existing data
        this.prices.clear();
        this.orderBooks.clear();
        this.isInitializing.clear();
    }
} 
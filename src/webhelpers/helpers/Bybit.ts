import { Exchange } from "./Exchange";
import { tickerData, Order, Orders, priceData } from "../types";
import { BYBIT_WS_URL, tickers } from '../constants';
import axios from 'axios';

interface BybitDepthUpdate {
    topic: string;
    type: string;
    ts: number;
    data: {
        s: string;       // Symbol
        b: string[][];   // Bids to be updated [price, size]
        a: string[][];   // Asks to be updated [price, size]
        u: number;       // Update ID
        seq: number;     // Sequence number
    };
}

export interface BybitTickerConfig {
    ticker: string;
    trackPrice?: boolean;
    trackOrderBook?: boolean;
    orderBookDepth?: 1 | 50 | 200 | 500; // Supported depths for Bybit
}

export class Bybit extends Exchange {
    protected name: string = 'BYBIT';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: BybitTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = BYBIT_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 20; // Number of order book levels to maintain in memory
    protected orderBooks: Map<string, { lastUpdateId: number, bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected isInitializing: Map<string, boolean> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();
    protected depthLevels: Map<string, number> = new Map(); // Store depth level for each ticker

    constructor(tickerConfigs: BybitTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        // Handle both string[] and BybitTickerConfig[] inputs
        if (typeof tickerConfigs[0] === 'string') {
            // If string array, assume tracking both price and order book with default depth
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true,
                orderBookDepth: 50 // Default depth
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as BybitTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}USDT`;
            
            // Default to true if not specified
            if (config.trackPrice !== false) {
                this.trackingPrice.add(formattedTicker);
            }
            
            if (config.trackOrderBook === true) {
                this.trackingOrderBook.add(formattedTicker);
                // Initialize flags only for tickers that need order book tracking
                this.isInitializing.set(formattedTicker, true);
                
                // Set depth level (default to 50 if not specified)
                const depthLevel = config.orderBookDepth || 50;
                this.depthLevels.set(formattedTicker, depthLevel);
            }
            
            return formattedTicker;
        });
    }

    public async start(): Promise<void> {
        await this.connect();
    }

    protected onMessage = (message: MessageEvent): priceData | null => {
        const data = JSON.parse(message.data);
        
        // Handle ping/pong for keeping connection alive
        if (data.ping) {
            this.ws.send(JSON.stringify({ pong: data.ping }));
            return null;
        }
        
        // Handle success response to subscription
        if (data.success === true && data.op === 'subscribe') {
            return null;
        }
        
        // Handle price updates from kline data
        if (data.topic && data.topic.includes('kline') && data.data && data.data.length > 0) {
            const ticker = data.topic.split('.')[2];
            // Only process price updates for tickers we're tracking prices for
            if (this.trackingPrice.has(ticker)) {
                return { ticker, price: parseFloat(data.data[0].close) };
            }
        } 
        // Handle order book updates
        else if (data.topic && data.topic.includes('orderbook') && data.type) {
            const parts = data.topic.split('.');
            const ticker = parts[2]; // orderbook.{depth}.{symbol}
            
            // Only process order book updates for tickers we're tracking order books for
            if (this.trackingOrderBook.has(ticker)) {
                if (data.type === 'snapshot') {
                    this.processOrderBookSnapshot(data as BybitDepthUpdate);
                } else if (data.type === 'delta') {
                    this.processOrderBookUpdate(data as BybitDepthUpdate);
                }
            }
        }
        return null;
    };

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        const subscriptionArgs: string[] = [];
        
        // Add kline subscriptions for price tracking
        tickers.forEach(ticker => {
            if (this.trackingPrice.has(ticker)) {
                subscriptionArgs.push(`kline.30.${ticker}`);
            }
            
            if (this.trackingOrderBook.has(ticker)) {
                const depthLevel = this.depthLevels.get(ticker) || 50;
                subscriptionArgs.push(`orderbook.${depthLevel}.${ticker}`);
            }
        });
        
        if (subscriptionArgs.length > 0) {
            const subscribePayload = JSON.stringify({
                op: 'subscribe',
                args: subscriptionArgs
            });
            ws.send(subscribePayload);
        }
        
        // Initialize order books after subscription
        // Note: For Bybit, we don't need to fetch a separate snapshot as the WebSocket
        // will send a snapshot message first, followed by delta updates
    };

    protected parseTicker = (ticker: string): string => ticker.replace('USDT', '');

    protected createTicker = (ticker: string): string => `${ticker}USDT`;

    /**
     * Process order book snapshot from WebSocket
     */
    protected processOrderBookSnapshot(data: BybitDepthUpdate): void {
        const ticker = data.topic.split('.')[2];
        
        // Initialize order book with snapshot data
        const bids = new Map<number, number>();
        const asks = new Map<number, number>();
        
        // Process bids
        if (data.data.b && data.data.b.length > 0) {
            data.data.b.forEach((bid: string[]) => {
                const price = parseFloat(bid[0]);
                const quantity = parseFloat(bid[1]);
                if (quantity > 0) {
                    bids.set(price, quantity);
                }
            });
        }
        
        // Process asks
        if (data.data.a && data.data.a.length > 0) {
            data.data.a.forEach((ask: string[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                if (quantity > 0) {
                    asks.set(price, quantity);
                }
            });
        }
        
        // Store the order book data
        this.orderBooks.set(ticker, { 
            lastUpdateId: data.data.u, 
            bids, 
            asks 
        });
        
        // Update the prices map with the order book data
        this.updatePricesOrderBook(ticker);
        
        // Mark as initialized
        this.isInitializing.set(ticker, false);
    }

    /**
     * Process order book delta updates from WebSocket
     */
    protected processOrderBookUpdate(data: BybitDepthUpdate): void {
        const ticker = data.topic.split('.')[2];
        
        // If we're still initializing, skip this update
        if (this.isInitializing.get(ticker)) {
            return;
        }
        
        // Get current order book
        const orderBook = this.orderBooks.get(ticker);
        
        // If we don't have an order book yet, ignore this update
        if (!orderBook) return;
        
        // Process bid updates
        if (data.data.b && data.data.b.length > 0) {
            data.data.b.forEach((bid: string[]) => {
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
        if (data.data.a && data.data.a.length > 0) {
            data.data.a.forEach((ask: string[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                
                if (quantity === 0) {
                    orderBook.asks.delete(price);
                } else {
                    orderBook.asks.set(price, quantity);
                }
            });
        }
        
        // Update lastUpdateId
        orderBook.lastUpdateId = data.data.u;
        
        // Update the prices map with the updated order book
        this.updatePricesOrderBook(ticker);
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

    /**
     * Fetch order book snapshot from Bybit REST API if needed
     * Note: This is a fallback method, as Bybit WebSocket provides snapshots
     */
    protected async fetchOrderBookSnapshot(ticker: string, depth: number = 50): Promise<any> {
        try {
            const response = await axios.get(`https://api.bybit.com/v5/market/orderbook`, {
                params: {
                    category: 'spot',
                    symbol: ticker,
                    limit: depth
                }
            });
            
            if (response.data && response.data.retCode === 0 && response.data.result) {
                return response.data.result;
            } else {
                throw new Error(`Invalid response from Bybit API: ${JSON.stringify(response.data)}`);
            }
        } catch (error) {
            console.error(`${this.name}: Error fetching order book snapshot for ${ticker}:`, error);
            throw error;
        }
    }

    public async connect(): Promise<void> {
        if(!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.ws = new WebSocket(this.wsURL);
        }
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => {
                if (!this.isClosing) {
                    this.subscribe(this.formattedTickers);
                    resolve(); // Resolve the promise when connection is established
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
                reject(error); // Reject the promise on error
            };
            
            this.ws.onclose = (event: CloseEvent) => {
                if (!this.isClosing && event.code !== 1013) {
                    setTimeout(() => {
                        this.connect();
                    }, 5000); // Wait 5 seconds before reconnecting
                }
            };
        });
    }

    public close(): void {
        this.isClosing = true;
        this.ws.close(1000, 'Closing connection');
    }
    public async changeTickers(newTickerConfigs: BybitTickerConfig[] | string[]): Promise<void> {
        try {
            await this.unsubscribeAll();
            
        // Update ticker configurations
        if (typeof newTickerConfigs[0] === 'string') {
            this.tickerConfigs = (newTickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true,
                orderBookDepth: 50
            }));
            this.tickers = newTickerConfigs as string[];
        } else {
            this.tickerConfigs = newTickerConfigs as BybitTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Clear tracking sets
        this.trackingOrderBook.clear();
        this.trackingPrice.clear();
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}USDT`;
            
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
        await this.start();
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
                args.push(`kline.30.${ticker}`);
            });
        }
        
        // Unsubscribe from order book updates
        this.formattedTickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                args.push(`orderbook.50.${ticker}`);
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
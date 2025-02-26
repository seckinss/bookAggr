import { Order, Orders } from '../types';
import { Exchange } from "./Exchange";
import { tickerData, priceData } from "../types";
import { BACKPACK_WS_URL, BACKPACK_API_URL } from '../constants';
import axios from 'axios';

interface DepthUpdate {
    s: string;       // Symbol
    a: any[][];      // Asks to be updated
    b: any[][];      // Bids to be updated
    U: string;       // First update ID
    u: string;       // Final update ID
}

export interface BackpackTickerConfig {
    ticker: string;
    trackPrice?: boolean;
    trackOrderBook?: boolean;
}

export class Backpack extends Exchange {
    protected name: string = 'BACKPACK';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: BackpackTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = BACKPACK_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 20; // Number of order book levels to maintain
    protected orderBooks: Map<string, { lastUpdateId: number, bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected depthUpdateBuffers: Map<string, DepthUpdate[]> = new Map();
    protected isInitializing: Map<string, boolean> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();

    constructor(tickerConfigs: BackpackTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        // Handle both string[] and BackpackTickerConfig[] inputs
        if (typeof tickerConfigs[0] === 'string') {
            // If string array, assume tracking both price and order book
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as BackpackTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}_USDC`;
            
            // Default to true if not specified
            if (config.trackPrice !== false) {
                this.trackingPrice.add(formattedTicker);
            }
            
            if (config.trackOrderBook === true) {
                this.trackingOrderBook.add(formattedTicker);
                // Initialize buffers and flags only for tickers that need order book tracking
                this.depthUpdateBuffers.set(formattedTicker, []);
                this.isInitializing.set(formattedTicker, true);
            }
            
            return formattedTicker;
        });
    }

    protected onMessage = (message: MessageEvent): priceData | null => {
        const data = JSON.parse(message.data);
        
        if (data.ping) {
            this.ws.send(JSON.stringify({ pong: data.ping }));
            return null;
        }
        // Handle ticker updates (price)
        if (data.stream && data.stream.split('.')[0] === 'ticker') {
            const ticker = data.data.s;
            // Only process price updates for tickers we're tracking prices for
            if (this.trackingPrice.has(ticker)) {
                return { ticker, price: parseFloat(data.data.c) };
            }
        } 
        // Handle depth updates (order book)
        else if (data.stream && data.stream.split('.')[0] === 'depth') {
            const ticker = data.data.s;
            // Only process depth updates for tickers we're tracking order books for
            if (this.trackingOrderBook.has(ticker)) {
                this.processDepthUpdate({
                    s: ticker,
                    a: data.data.a,
                    b: data.data.b,
                    U: data.data.U,
                    u: data.data.u
                });
            }
        }
        return null;
    };

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        const subscriptionParams: string[] = [];
        
        // Add ticker and depth subscriptions only for tickers that need them
        tickers.forEach(ticker => {
            if (this.trackingPrice.has(ticker)) {
                subscriptionParams.push(`ticker.${ticker}`);
            }
            
            if (this.trackingOrderBook.has(ticker)) {
                subscriptionParams.push(`depth.200ms.${ticker}`);
            }
        });
        
        if (subscriptionParams.length > 0) {
            const subscribePayload = JSON.stringify({
                method: "SUBSCRIBE",
                params: subscriptionParams
            });
            ws.send(subscribePayload);
        }
        
        // Start initializing order books after subscription, but only for tickers tracking order books
        tickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                this.initializeOrderBook(ticker);
            }
        });
    };

    protected parseTicker = (ticker: string): string => ticker.replace('_USDC', '');

    protected createTicker = (ticker: string): string => `${ticker}_USDC`;

    /**
     * Process depth update messages from WebSocket
     * Either buffer them during initialization or apply them directly
     */
    protected processDepthUpdate(data: DepthUpdate): void {
        const ticker = data.s;
        
        // If we're still initializing, buffer the update
        if (this.isInitializing.get(ticker)) {
            const buffer = this.depthUpdateBuffers.get(ticker) || [];
            buffer.push(data);
            this.depthUpdateBuffers.set(ticker, buffer);
            return;
        }
        
        // Otherwise, apply the update directly
        this.applyDepthUpdate(ticker, data);
    }

    /**
     * Initialize order book for a ticker following Backpack's API
     */
    protected async initializeOrderBook(ticker: string): Promise<void> {
        try {
            // Mark as initializing
            this.isInitializing.set(ticker, true);
            
            // Clear any existing buffer
            this.depthUpdateBuffers.set(ticker, []);
            
            // Wait for at least one depth update to arrive
            await new Promise<void>(resolve => {
                const checkBuffer = () => {
                    const buffer = this.depthUpdateBuffers.get(ticker) || [];
                    if (buffer.length > 0) {
                        resolve();
                    } else {
                        setTimeout(checkBuffer, 100);
                    }
                };
                checkBuffer();
            });
            
            // Fetch snapshot from Backpack API
            const snapshot = await this.fetchOrderBookSnapshot(ticker);
            
            // Initialize order book with snapshot data
            const bids = new Map<number, number>();
            const asks = new Map<number, number>();
            
            snapshot.bids.forEach((bid: any[]) => {
                const price = parseFloat(bid[0]);
                const quantity = parseFloat(bid[1]);
                if (quantity > 0) {
                    bids.set(price, quantity);
                }
            });
            
            snapshot.asks.forEach((ask: any[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                if (quantity > 0) {
                    asks.set(price, quantity);
                }
            });
            
            // Store the order book data
            this.orderBooks.set(ticker, { 
                lastUpdateId: parseInt(snapshot.lastUpdateId), 
                bids, 
                asks 
            });
            
            // Process buffered events
            const buffer = this.depthUpdateBuffers.get(ticker) || [];
            const validEvents = buffer.filter(event => parseInt(event.u) > parseInt(snapshot.lastUpdateId));
            
            // Apply all valid events
            for (const event of validEvents) {
                this.applyDepthUpdate(ticker, event);
            }
            
            // Update the prices map with the order book data
            this.updatePricesOrderBook(ticker);
            
            // Mark as initialized
            this.isInitializing.set(ticker, false);
            this.depthUpdateBuffers.set(ticker, []);
            
        } catch (error) {
            console.error(`${this.name}: Error initializing order book for ${ticker}:`, error);
            // Retry after a delay
            setTimeout(() => this.initializeOrderBook(ticker), 5000);
        }
    }

    /**
     * Fetch order book snapshot from Backpack REST API
     */
    protected async fetchOrderBookSnapshot(ticker: string): Promise<any> {
        try {
            // Replace direct API call with your proxy endpoint
            const response = await axios.get(`/api/backpack/depth`, {
                params: {
                    symbol: ticker
                }
            });
            return response.data;
        } catch (error) {
            console.error(`${this.name}: Error fetching order book snapshot for ${ticker}:`, error);
            throw error;
        }
    }

    /**
     * Apply a depth update to the order book
     */
    protected applyDepthUpdate(ticker: string, data: DepthUpdate): void {
        // Get current order book
        const orderBook = this.orderBooks.get(ticker);
        
        // If we don't have an order book yet, ignore this update
        if (!orderBook) return;
        
        // If this update is older than our current state, ignore it
        if (parseInt(data.u) <= orderBook.lastUpdateId) return;
        
        // Process bid updates
        if (data.b && data.b.length > 0) {
            data.b.forEach((bid: any[]) => {
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
        if (data.a && data.a.length > 0) {
            data.a.forEach((ask: any[]) => {
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
        orderBook.lastUpdateId = parseInt(data.u);
        
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

    public async start(): Promise<void> {
        await this.connect();
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
                this.start();
            }
        };
    });
    }

    public close(): void {
        this.isClosing = true;
        this.ws.close(1000, 'Closing connection');
    }
    public async changeTickers(newTickerConfigs: BackpackTickerConfig[] | string[]): Promise<void> {
        try {
            await this.unsubscribeAll();
            if (this.ws.readyState !== WebSocket.OPEN) {
                console.error(`${this.name}: WebSocket not open, reconnecting...`);
                await this.start();
            }
        // Update ticker configurations
        if (typeof newTickerConfigs[0] === 'string') {
            this.tickerConfigs = (newTickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = newTickerConfigs as string[];
        } else {
            this.tickerConfigs = newTickerConfigs as BackpackTickerConfig[];
            this.tickers = this.tickerConfigs.map(config => config.ticker);
        }
        
        // Clear tracking sets
        this.trackingOrderBook.clear();
        this.trackingPrice.clear();
        
        // Format tickers and set up tracking sets
        this.formattedTickers = this.tickerConfigs.map(config => {
            const formattedTicker = `${config.ticker}_USDC`;
            
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
        const streams: any[] = [];
        if (this.trackingPrice.size > 0) {
            this.trackingPrice.forEach(ticker => {
                streams.push(`ticker.${ticker}`);
            });
        }
        
        // Unsubscribe from order book updates
        this.formattedTickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                streams.push(`depth.200ms.${ticker}`);
            }
        });
        
        if (streams.length > 0) {
            const unsubscribePayload = JSON.stringify({
                method: 'UNSUBSCRIBE',
                params: streams
            });
            this.ws.send(unsubscribePayload);   
        };
        
        // Clear existing data
        this.prices.clear();
        this.orderBooks.clear();
        this.isInitializing.clear();
    }
}


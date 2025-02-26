import { Exchange } from "./Exchange";
import { tickerData, Order, Orders, priceData } from "../types";
import { BINANCE_WS_URL } from '../constants';

interface DepthUpdate {
    e: string;       // Event type
    E: number;       // Event time
    s: string;       // Symbol
    U: number;       // First update ID
    u: number;       // Final update ID
    b: string[][];   // Bids to be updated
    a: string[][];   // Asks to be updated
}

export interface BinanceTickerConfig {
    ticker: string;
    trackPrice?: boolean;
    trackOrderBook?: boolean;
}

export class Binance extends Exchange {
    protected name: string = 'BINANCE';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: BinanceTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = BINANCE_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 20; // Number of order book levels to maintain
    protected orderBooks: Map<string, { lastUpdateId: number, bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected depthUpdateBuffers: Map<string, DepthUpdate[]> = new Map();
    protected isInitializing: Map<string, boolean> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();

    constructor(tickerConfigs: BinanceTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        // Handle both string[] and BinanceTickerConfig[] inputs
        if (typeof tickerConfigs[0] === 'string') {
            // If string array, assume tracking both price and order book
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as BinanceTickerConfig[];
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
                // Initialize buffers and flags only for tickers that need order book tracking
                this.depthUpdateBuffers.set(formattedTicker, []);
                this.isInitializing.set(formattedTicker, true);
            }
            
            return formattedTicker;
        });
    }

    public async start(): Promise<void> {
        await this.connect();
    }

    protected onMessage = (event: MessageEvent): priceData | null => {
        const data = JSON.parse(event.data);
        
        // Handle pong message
        if (data.ping) {
            this.ws.send(JSON.stringify({ pong: data.ping }));
            return null;
        }  
        if (data.e && data.e === '24hrMiniTicker') {
            const ticker = data.s;
            // Only process price updates for tickers we're tracking prices for
            if (this.trackingPrice.has(ticker)) {
                return { ticker, price: parseFloat(data.c) };
            }
        } else if (data.e && data.e === 'depthUpdate') {
            const ticker = data.s;
            // Only process depth updates for tickers we're tracking order books for
            if (this.trackingOrderBook.has(ticker)) {
                this.processDepthUpdate(data);
            }
        }
        return null;
    };

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        const subscriptionParams: string[] = [];
        
        // Add miniTicker subscriptions only for tickers tracking price
        tickers.forEach(ticker => {
            if (this.trackingPrice.has(ticker)) {
                subscriptionParams.push(`${ticker.toLowerCase()}@miniTicker`);
            }
            
            if (this.trackingOrderBook.has(ticker)) {
                subscriptionParams.push(`${ticker.toLowerCase()}@depth`);
            }
        });
        
        if (subscriptionParams.length > 0) {
            const subscribePayload = JSON.stringify({
                method: "SUBSCRIBE",
                params: subscriptionParams,
                id: 1
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

    protected parseTicker = (ticker: string): string => ticker.replace('USDT', '');

    protected createTicker = (ticker: string): string => `${ticker}USDT`;

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
     * Initialize order book for a ticker following Binance's recommended procedure
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
            
            // Get the first buffered event's U value
            const buffer = this.depthUpdateBuffers.get(ticker) || [];
            const firstEvent = buffer[0];
            const firstEventU = firstEvent.U;
            
            // Fetch snapshot and validate
            let snapshot = await this.fetchOrderBookSnapshot(ticker);
            
            // If snapshot's lastUpdateId is less than the first event's U, fetch a new snapshot
            if (snapshot.lastUpdateId < firstEventU) {
                console.log(`${this.name}: Snapshot outdated for ${ticker}, fetching new snapshot...`);
                snapshot = await this.fetchOrderBookSnapshot(ticker);
            }
            
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
                lastUpdateId: snapshot.lastUpdateId, 
                bids, 
                asks 
            });
            
            // Process buffered events
            const validEvents = buffer.filter(event => event.u > snapshot.lastUpdateId);
            
            // Validate the first event
            if (validEvents.length > 0) {
                const firstValidEvent = validEvents[0];
                
                // Check if the first valid event meets the condition:
                // U <= lastUpdateId+1 AND u >= lastUpdateId+1
                if (!(firstValidEvent.U <= snapshot.lastUpdateId + 1 && firstValidEvent.u >= snapshot.lastUpdateId + 1)) {
                    // Try again
                    return this.initializeOrderBook(ticker);
                }
                
                // Apply all valid events
                for (const event of validEvents) {
                    this.applyDepthUpdate(ticker, event);
                }
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
     * Fetch order book snapshot from Binance REST API
     */
    protected async fetchOrderBookSnapshot(ticker: string): Promise<any> {
        try {
            const response = await fetch(`https://api.binance.com/api/v3/depth?symbol=${ticker}&limit=1000`);
            return await response.json();
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
        if (data.u <= orderBook.lastUpdateId) return;
        
        // If there's a gap between our current state and this update, reinitialize
        if (data.U > orderBook.lastUpdateId + 1) {
            this.isInitializing.set(ticker, true);
            this.initializeOrderBook(ticker);
            return;
        }
        
        // Process bid updates
        data.b.forEach((bid: string[]) => {
            const price = parseFloat(bid[0]);
            const quantity = parseFloat(bid[1]);
            
            if (quantity === 0) {
                orderBook.bids.delete(price);
            } else {
                orderBook.bids.set(price, quantity);
            }
        });
        
        // Process ask updates
        data.a.forEach((ask: string[]) => {
            const price = parseFloat(ask[0]);
            const quantity = parseFloat(ask[1]);
            
            if (quantity === 0) {
                orderBook.asks.delete(price);
            } else {
                orderBook.asks.set(price, quantity);
            }
        });
        
        // Update lastUpdateId
        orderBook.lastUpdateId = data.u;
        
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

    public async connect(): Promise<void> {
        if(!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.ws = new WebSocket(this.wsURL);
        }
        // Return a promise that resolves when the connection is established
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => {
                if (!this.isClosing) {
                    this.subscribe(this.formattedTickers);
                }
                resolve();
            };
            
            this.ws.onmessage = (event) => {
                const result = this.onMessage(event);
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
            
            this.ws.onclose = (event) => {
                if (!this.isClosing && event.code !== 1000) {
                    this.start();
                }
            };
        });
    }

    public close(): void {
        this.isClosing = true;
        this.ws.close(1000, 'Closing connection');
    }
    public async changeTickers(newTickerConfigs: BinanceTickerConfig[] | string[]): Promise<void> {
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
            this.tickerConfigs = newTickerConfigs as BinanceTickerConfig[];
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
        throw error;
    }
}
    protected async unsubscribeAll(): Promise<void> {
        if (this.ws.readyState !== WebSocket.OPEN) {
            console.error(`${this.name}: WebSocket not open, cannot unsubscribe`);
            return;
        }
        // Unsubscribe from price updates
        const params: any[] = [];
        if (this.trackingPrice.size > 0) {
            this.trackingPrice.forEach(ticker => {
                params.push(`${ticker.toLowerCase()}@miniTicker`);
            });
        }
        
        // Unsubscribe from order book updates
        this.formattedTickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                params.push(`${ticker.toLowerCase()}@depth`);
            }
        });
        
        if (params.length > 0) {
            const unsubscribePayload = JSON.stringify({
                method: 'UNSUBSCRIBE',
                params: params,
                id: 1
            });
            this.ws.send(unsubscribePayload);
        };
        
        // Clear existing data
        this.prices.clear();
        this.orderBooks.clear();
        this.isInitializing.clear();
    }
}
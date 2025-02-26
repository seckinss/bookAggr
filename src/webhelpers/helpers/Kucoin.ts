import { Exchange } from "./Exchange";
import { tickerData, Order, priceData } from "../types";
import { KUCOIN_WS_URL } from '../constants';
import axios from 'axios';

interface KucoinLevel2Update {
    topic: string;
    type: string;
    data: {
        sequenceStart: number;
        sequenceEnd: number;
        symbol: string;
        changes: {
            asks: string[][];
            bids: string[][];
        };
    };
}

export interface KucoinTickerConfig {
    ticker: string;
    trackPrice?: boolean;
    trackOrderBook?: boolean;
}

export class Kucoin extends Exchange {
    protected name: string = 'KUCOIN';
    protected ws: WebSocket;
    public prices: Map<string, tickerData> = new Map();
    protected tickerConfigs: KucoinTickerConfig[] = [];
    protected formattedTickers: string[] = [];
    protected tickers: string[] = []; // Required by abstract class
    protected wsURL: string = KUCOIN_WS_URL;
    protected isClosing: boolean = false;
    protected orderBookDepth: number = 20; // Number of order book levels to maintain
    protected orderBooks: Map<string, { lastUpdateId: number, bids: Map<number, number>, asks: Map<number, number> }> = new Map();
    protected isInitializing: Map<string, boolean> = new Map();
    protected trackingOrderBook: Set<string> = new Set();
    protected trackingPrice: Set<string> = new Set();
    protected pingInterval: NodeJS.Timeout | null = null;

    constructor(tickerConfigs: KucoinTickerConfig[] | string[]) {
        super();
        this.ws = new WebSocket(this.wsURL);
        
        // Handle both string[] and KucoinTickerConfig[] inputs
        if (typeof tickerConfigs[0] === 'string') {
            // If string array, assume tracking both price and order book
            this.tickerConfigs = (tickerConfigs as string[]).map(ticker => ({
                ticker,
                trackPrice: true,
                trackOrderBook: true
            }));
            this.tickers = tickerConfigs as string[];
        } else {
            this.tickerConfigs = tickerConfigs as KucoinTickerConfig[];
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
        await this.initializeWebSocket();
    }

    private async initializeWebSocket(): Promise<void> {
        const endpoint = await this.getEndpoint();
        this.ws = new WebSocket(endpoint);
        await this.connect();
    }

    private async getEndpoint(): Promise<string> {
        const response = await fetch("/api/kucoin/bullet-public", {
            method: "POST"
        });
        const data = await response.json();
        return `${KUCOIN_WS_URL}?token=${data.data.token}`;
    }

    protected onMessage = (message: MessageEvent): priceData | null => {
        const data = JSON.parse(message.data);
        
        // Handle different ping message formats from Kucoin
        if (data.type === 'ping') {
            // For messages with type: 'ping'
            this.ws.send(JSON.stringify({ type: 'pong', id: data.id }));
            return null;
        } else if (data.ping) {
            // For messages with a ping property
            this.ws.send(JSON.stringify({ pong: data.ping }));
            return null;
        } else if (data.type === 'welcome') {
            // When connection is established, start sending ping messages
            this.setupPingInterval(this.ws);
            return null;
        }
        
        // Handle ticker updates (price)
        if (data.data && data.topic && data.topic.startsWith('/market/ticker:')) {
            const ticker = data.topic.split(':')[1];
            // Only process price updates for tickers we're tracking prices for
            if (this.trackingPrice.has(ticker)) {
                return { ticker, price: parseFloat(data.data.price) };
            }
        } 
        // Handle level2 updates (order book)
        else if (data.data && data.topic && data.topic.startsWith('/market/level2:')) {
            const ticker = data.topic.split(':')[1];
            // Only process order book updates for tickers we're tracking order books for
            if (this.trackingOrderBook.has(ticker)) {
                this.processOrderBookUpdate(data as KucoinLevel2Update);
            }
        }
        return null;
    };

    // Separate method to set up ping interval
    private setupPingInterval(ws: WebSocket): void {
        // Clear any existing interval first
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
        // Set up a new ping interval
        this.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    const pingEvent = JSON.stringify({ id: Date.now(), type: "ping" });
                    ws.send(pingEvent);
                    console.log(`${this.name}: Sent ping`);
                } catch (error) {
                    console.error(`${this.name}: Error sending ping:`, error);
                    if (this.pingInterval) {
                        clearInterval(this.pingInterval);
                        this.pingInterval = null;
                    }
                }
            } else {
                console.warn(`${this.name}: WebSocket not open, clearing ping interval`);
                if (this.pingInterval) {
                    clearInterval(this.pingInterval);
                    this.pingInterval = null;
                }
            }
        }, 18000); // Slightly longer interval (20 seconds)
    }

    protected onSubscribe = (ws: WebSocket, tickers: string[]): void => {
        if(this.ws.readyState !== WebSocket.OPEN) return;
        
        // Subscribe to price updates
        const priceSubscriptions = tickers.filter(ticker => this.trackingPrice.has(ticker));
        if (priceSubscriptions.length > 0) {
            const priceSubscribePayload = JSON.stringify({
                id: Date.now(),
                type: 'subscribe',
                topic: `/market/ticker:${priceSubscriptions.join(',')}`,
                response: true,
            });
            ws.send(priceSubscribePayload);
        }
        
        // Subscribe to order book updates
        tickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                const orderBookSubscribePayload = JSON.stringify({
                    id: Date.now() + 1,
                    type: 'subscribe',
                    topic: `/market/level2:${ticker}`,
                    response: true,
                });
                ws.send(orderBookSubscribePayload);
                
                // Initialize order book
                this.initializeOrderBook(ticker);
            }
        });
        
        // Ping interval is now set up in onMessage when welcome message is received
    };

    protected parseTicker = (ticker: string): string => ticker.replace('-USDT', '');

    protected createTicker = (ticker: string): string => `${ticker}-USDT`;

    /**
     * Process order book updates from WebSocket
     */
    protected processOrderBookUpdate(data: KucoinLevel2Update): void {
        const ticker = data.topic.split(':')[1];
        
        // If we're still initializing, skip this update
        if (this.isInitializing.get(ticker)) {
            return;
        }
        
        // Get current order book
        const orderBook = this.orderBooks.get(ticker);
        
        // If we don't have an order book yet, ignore this update
        if (!orderBook) return;
        
        // Process bid updates
        if (data.data.changes.bids && data.data.changes.bids.length > 0) {
            data.data.changes.bids.forEach((bid: string[]) => {
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
        if (data.data.changes.asks && data.data.changes.asks.length > 0) {
            data.data.changes.asks.forEach((ask: string[]) => {
                const price = parseFloat(ask[0]);
                const quantity = parseFloat(ask[1]);
                
                if (quantity === 0) {
                    orderBook.asks.delete(price);
                } else {
                    orderBook.asks.set(price, quantity);
                }
            });
        }
        
        // Update lastUpdateId (using sequenceEnd as Kucoin's update ID)
        orderBook.lastUpdateId = data.data.sequenceEnd;
        
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
            
            // Fetch snapshot from Kucoin API
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
                lastUpdateId: snapshot.sequence, 
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
     * Fetch order book snapshot from Kucoin REST API
     */
    protected async fetchOrderBookSnapshot(ticker: string): Promise<any> {
        try {
            const response = await axios.get(`/api/kucoin/level2_100`, {
                params: {
                    symbol: ticker
                }
            });
            
            if (response.data && response.data.code === '200000' && response.data.data) {
                return response.data.data;
            } else {
                throw new Error(`Invalid response from Kucoin API: ${JSON.stringify(response.data)}`);
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
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => {
                if (!this.isClosing) {
                    this.subscribe(this.formattedTickers);
                    // Start ping interval immediately after connection
                    this.setupPingInterval(this.ws);
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
            this.ws.onerror = (event: Event) => {
                console.error(`${this.name} WS error:`, event);
                reject(event);
            };
            this.ws.onclose = (event: CloseEvent) => {
                console.log(`${this.name}: WebSocket closed with code ${event.code}`);
                // Clear ping interval on close
                if (this.pingInterval) {
                    clearInterval(this.pingInterval);
                    this.pingInterval = null;
                }
                
                if (!this.isClosing && event.code !== 1013) {
                    this.initializeWebSocket();
                }
            };
        });
    }

    public close(): void {
        this.isClosing = true;
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        this.ws.close(1000, 'Closing connection');
    }

    /**
     * Unsubscribe from all current subscriptions
     */
    protected async unsubscribeAll(): Promise<void> {
        if (this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        
        // Unsubscribe from price updates
        const priceSubscriptions = this.formattedTickers.filter(ticker => this.trackingPrice.has(ticker));
        if (priceSubscriptions.length > 0) {
            const priceUnsubscribePayload = JSON.stringify({
                id: Date.now(),
                type: 'unsubscribe',
                topic: `/market/ticker:${priceSubscriptions.join(',')}`,
            });
            this.ws.send(priceUnsubscribePayload);
        }
        
        // Unsubscribe from order book updates
        this.formattedTickers.forEach(ticker => {
            if (this.trackingOrderBook.has(ticker)) {
                const orderBookUnsubscribePayload = JSON.stringify({
                    id: Date.now() + 1,
                    type: 'unsubscribe',
                    topic: `/market/level2:${ticker}`,
                });
                this.ws.send(orderBookUnsubscribePayload);
            }
        });
        
        // Clear existing data
        this.prices.clear();
        this.orderBooks.clear();
        this.isInitializing.clear();
    }

    /**
     * Unsubscribe from current tickers and subscribe to new ones
     * @param newTickerConfigs New ticker configurations to subscribe to
     */
    public async changeTickers(newTickerConfigs: KucoinTickerConfig[] | string[]): Promise<void> {
        try {
            // First unsubscribe from current tickers
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
                this.tickerConfigs = newTickerConfigs as KucoinTickerConfig[];
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
            
            // Check if WebSocket is still open, reconnect if needed
            if (this.ws.readyState !== WebSocket.OPEN) {
                await this.initializeWebSocket();
            } else {
                // Subscribe to new tickers
                this.subscribe(this.formattedTickers);
            }
        } catch (error) {
            console.error(`${this.name}: Error changing tickers:`, error);
            // If there was an error, try to reconnect
            await this.initializeWebSocket();
        }
    }
} 
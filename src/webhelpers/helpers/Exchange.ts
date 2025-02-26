import { tickerData, priceData } from "../types";

export abstract class Exchange {
    protected abstract name: string;
    protected abstract ws: WebSocket;
    protected abstract prices: Map<string, tickerData>;
    protected abstract tickers: string[];
    protected abstract onMessage: (message: MessageEvent) => priceData | null;
    protected abstract onSubscribe: (ws: WebSocket, tickers: string[]) => void;
    protected abstract parseTicker: (ticker: string) => string;
    protected abstract createTicker: (ticker: string) => string;
    public abstract start(): void;
    protected abstract wsURL: string;
    protected abstract isClosing: boolean;

    public abstract connect(): void;
    public abstract close(): void;
    public subscribe(tickers: string[]): void {
        this.onSubscribe(this.ws, tickers);
    }
}
"use client";

import { useState, useEffect, useRef } from "react";
import { Binance } from "../webhelpers/helpers/Binance";
import { Bybit } from "../webhelpers/helpers/Bybit";
import { OKX } from "../webhelpers/helpers/OKX";
import { tickers } from "../webhelpers/constants";
import { Order } from "../webhelpers/types";
import { Kucoin } from "../webhelpers/helpers/Kucoin";
// Component to display aggregated order book
import { Backpack } from "../webhelpers/helpers/Backpack";
export default function Home() {
  const [selectedTicker, setSelectedTicker] = useState("BTC");
  const [orderbookDepth, setOrderbookDepth] = useState(15); // Default depth
  const [aggregatedOrderBook, setAggregatedOrderBook] = useState<{
    bids: Order[];
    asks: Order[];
  }>({ bids: [], asks: [] });
  const [exchanges, setExchanges] = useState<{
    binance: Binance | null;
    bybit: Bybit | null;
    okx: OKX | null;
    kucoin: Kucoin | null;
    backpack: Backpack | null;
  }>({
    binance: null,
    bybit: null,
    okx: null,
    kucoin: null,
    backpack: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);

  // Initialize exchange connections
  useEffect(() => {
    let activeExchanges = { ...exchanges };
    
    const updateExchangeTickers = async () => {
      try {
        setIsLoading(true);
        
        // If exchanges already exist, update their tickers instead of creating new instances
        if (activeExchanges.binance && exchanges.bybit && exchanges.okx && exchanges.kucoin && exchanges.backpack) {
          await Promise.all([
            activeExchanges.binance.changeTickers([{ ticker: selectedTicker, trackOrderBook: true }]),
            exchanges.bybit.changeTickers([{ ticker: selectedTicker, trackOrderBook: true }]),
            exchanges.okx.changeTickers([{ ticker: selectedTicker, trackOrderBook: true }]),
            exchanges.kucoin.changeTickers([{ ticker: selectedTicker, trackOrderBook: true }]),
            exchanges.backpack.changeTickers([{ ticker: selectedTicker, trackOrderBook: true }]),
          ]);
        } else {
          // First time initialization
          const binance = new Binance([{ ticker: selectedTicker, trackOrderBook: true }]);
          const bybit = new Bybit([{ ticker: selectedTicker, trackOrderBook: true }]);
          const okx = new OKX([{ ticker: selectedTicker, trackOrderBook: true }]);
          const kucoin = new Kucoin([{ ticker: selectedTicker, trackOrderBook: true }]);
          const backpack = new Backpack([{ ticker: selectedTicker, trackOrderBook: true }]);
          
          // Start connections
          await Promise.all([
            binance.start(),
            bybit.start(),
            okx.start(),
            kucoin.start(),
            backpack.start(),
          ]);

          // Update state with exchange instances
          activeExchanges = {
            binance,
            bybit,
            okx,
            kucoin,
            backpack,
          };
          setExchanges(activeExchanges);
        }
        setIsLoading(false);
      } catch (error) {
        console.error("Error updating exchanges:", error);
      }
    };

    updateExchangeTickers();

    // Cleanup function only when component unmounts or ticker changes
    return () => {
      // Only close exchanges if we're unmounting or changing tickers
      // We'll create new instances or update existing ones in the next effect
      setAggregatedOrderBook({ bids: [], asks: [] });
    };
  }, [selectedTicker]); // Only depend on selectedTicker

  // Separate useEffect for component unmount cleanup
  useEffect(() => {
    return () => {
      Object.values(exchanges).forEach((exchange) => {
        if (exchange) exchange.close();
      });
    };
  }, []); // Empty dependency array means this runs only on unmount

  // Aggregate order books from all exchanges
  useEffect(() => {
    if (isLoading) return;

    const intervalId = setInterval(() => {
      // Collect all bids and asks from exchanges
      let allBids: Order[] = [];
      let allAsks: Order[] = [];
      let prices: number[] = [];

      Object.values(exchanges).forEach((exchange) => {
        if (!exchange) return;
        
        const tickerData = exchange.prices.get(selectedTicker);
        if (!tickerData || !tickerData.orders) return;

        // Add exchange bids and asks to combined arrays
        allBids = [...allBids, ...tickerData.orders.bid];
        allAsks = [...allAsks, ...tickerData.orders.ask];
        
        // Collect price for average calculation
        if (tickerData.price) {
          prices.push(tickerData.price);
        }
      });

      // Calculate average price if available
      if (prices.length > 0) {
        const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        setCurrentPrice(avgPrice);
      }

      // Aggregate and sort bids (descending) and asks (ascending)
      const aggregatedBids = aggregateOrders(allBids, true);
      const aggregatedAsks = aggregateOrders(allAsks, false);

      setAggregatedOrderBook({
        bids: aggregatedBids.slice(0, orderbookDepth), // Use selected depth
        asks: aggregatedAsks.slice(0, orderbookDepth), // Use selected depth
      });
    }, 100);

    return () => clearInterval(intervalId);
  }, [exchanges, isLoading, selectedTicker, orderbookDepth]); // Add orderbookDepth as dependency

  // Helper function to aggregate orders at the same price level
  const aggregateOrders = (orders: Order[], isBid: boolean): Order[] => {
    const priceMap = new Map<number, number>();
    
    // Sum up sizes for the same price
    orders.forEach((order) => {
      const currentSize = priceMap.get(order.price) || 0;
      priceMap.set(order.price, currentSize + order.size);
    });
    
    // Convert back to array and sort
    return Array.from(priceMap.entries())
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => isBid ? b.price - a.price : a.price - b.price);
  };

  // Calculate the spread between best bid and ask
  const spread = aggregatedOrderBook.bids.length > 0 && aggregatedOrderBook.asks.length > 0
    ? aggregatedOrderBook.asks[0].price - aggregatedOrderBook.bids[0].price
    : null;
  
  const spreadPercentage = spread && currentPrice
    ? (spread / currentPrice) * 100
    : null;

  /**
   * Format price with appropriate precision based on price magnitude
   * - Uses significant digits approach for better readability
   * - Handles different price ranges appropriately
   * - Avoids showing unnecessary zeros
   */
  const formatPrice = (price: number | null): string => {
    if (price === null) return "Loading...";
    
    // For zero or invalid values
    if (price === 0 || !isFinite(price)) return "0";
    
    // Get absolute value and determine magnitude
    const absPrice = Math.abs(price);
    
    // Format based on price ranges
    if (absPrice < 0.000001) {
      // Extremely small values (< 0.000001) - scientific notation
      return price.toExponential(2);
    } else if (absPrice < 0.001) {
      // Very small values - 8 significant digits
      return price.toPrecision(8).replace(/\.?0+$/, '');
    } else if (absPrice < 0.01) {
      // Small values - 6 significant digits
      return price.toPrecision(6).replace(/\.?0+$/, '');
    } else if (absPrice < 1) {
      // Medium-small values - 4 decimal places
      return price.toFixed(4).replace(/\.?0+$/, '');
    } else if (absPrice < 100) {
      // Normal values - 2 decimal places
      return price.toFixed(2).replace(/\.?0+$/, '');
    } else {
      return price.toFixed(2);
    }
  };

  // Add this new function to your component
  const getSourcesForPrice = (price: number, isBid: boolean) => {
    const sources: Record<string, number> = {};
    
    // Check each exchange for orders at this price
    Object.entries(exchanges).forEach(([exchangeName, exchange]) => {
      if (!exchange) return;
      
      const tickerData = exchange.prices.get(selectedTicker);
      if (!tickerData || !tickerData.orders) return;
      
      // Get the orders array based on whether it's a bid or ask
      const orders = isBid ? tickerData.orders.bid : tickerData.orders.ask;
      
      // Find orders at this price level
      const matchingOrders = orders.filter(order => order.price === price);
      
      if (matchingOrders.length > 0) {
        // Calculate total size from this exchange at this price
        const totalSize = matchingOrders.reduce((sum, order) => sum + order.size, 0);
        sources[exchangeName] = totalSize;
      }
    });
    
    return sources;
  };

  const removeAllTooltips = () => {
    // Remove any existing tooltips
    document.querySelectorAll('[id^="tooltip-"]').forEach(el => el.remove());
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      {/* Header */}
      <header className="border-b border-gray-800/50 p-4 backdrop-blur-sm bg-black/30 sticky top-0 z-10">
        <div className="container mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center">
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center mr-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">Crypto Order Book Aggregator</h1>
          </div>
          <div className="flex items-center space-x-4">
            {/* Ticker selector */}
            <div className="relative">
              <select
                className="appearance-none bg-gray-800/70 border border-gray-700/50 rounded-lg px-4 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 backdrop-blur-sm"
                value={selectedTicker}
                onChange={(e) => setSelectedTicker(e.target.value)}
                disabled={isLoading}
              >
                {tickers.map((ticker) => (
                  <option key={ticker} value={ticker}>
                    {ticker}/USDT
                  </option>
                ))}
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
                <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                  <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                </svg>
              </div>
            </div>
            
            {/* Orderbook depth selector */}
            <div className="flex items-center">
              <label htmlFor="depth-selector" className="text-gray-400 mr-2 whitespace-nowrap">
                Depth:
              </label>
              <div className="relative">
                <select
                  id="depth-selector"
                  className="appearance-none bg-gray-800/70 border border-gray-700/50 rounded-lg px-4 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200 backdrop-blur-sm"
                  value={orderbookDepth}
                  onChange={(e) => setOrderbookDepth(Number(e.target.value))}
                  disabled={isLoading}
                >
                  <option value={5}>5 levels</option>
                  <option value={10}>10 levels</option>
                  <option value={15}>15 levels</option>
                  <option value={25}>25 levels</option>
                  <option value={50}>50 levels</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-gray-400">
                  <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                    <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto p-4 pt-6">
        {isLoading ? (
          <div className="flex flex-col justify-center items-center h-64">
            <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500 mb-4"></div>
            <p className="text-gray-400">Connecting to exchanges...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6">
            {/* Current price and spread */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl p-6 shadow-lg border border-gray-700/30">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-gray-400 mb-1">Current Price</h2>
                  <div className="flex items-baseline">
                    <p className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-green-400 to-emerald-500 bg-clip-text text-transparent">
                      ${currentPrice ? formatPrice(currentPrice) : "Loading..."}
                    </p>
                    <span className="ml-2 text-sm text-gray-400">USDT</span>
                  </div>
                </div>
                <div className="h-12 w-px bg-gray-700/50 hidden md:block"></div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-gray-400 mb-1">Spread</h2>
                  <div className="flex items-baseline">
                    <p className="text-2xl md:text-3xl font-bold text-blue-400">
                      {spread ? formatPrice(spread) : "Loading..."}
                    </p>
                    <span className="text-sm text-gray-400 ml-2">
                      ({spreadPercentage ? spreadPercentage.toFixed(4) : "0"}%)
                    </span>
                  </div>
                </div>
                <div className="h-12 w-px bg-gray-700/50 hidden md:block"></div>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-gray-400 mb-1">Exchange Status</h2>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(exchanges).map(([name, exchange]) => (
                      <div key={name} className="flex items-center">
                        <div className={`w-2 h-2 rounded-full mr-1 ${exchange ? 'bg-green-500' : 'bg-red-500'}`}></div>
                        <span className="text-sm capitalize">{name}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Order book */}
            <div className="bg-gray-800/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden border border-gray-700/30">
              <div className="p-4 border-b border-gray-700/50">
                <h2 className="text-xl font-bold">Aggregated Order Book</h2>
                <p className="text-sm text-gray-400">
                  Combined data from Binance, Bybit, Kucoin, OKX, and Backpack • Showing {orderbookDepth} levels
                </p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-700/50">
                {/* Bids */}
                <div className="p-4">
                  <div className="flex justify-between text-sm text-gray-400 mb-2 pb-2 border-b border-gray-700/30">
                    <span>Price (USDT)</span>
                    <span>Size ({selectedTicker})</span>
                  </div>
                  <div className="space-y-1 max-h-[500px] overflow-y-auto custom-scrollbar">
                    {aggregatedOrderBook.bids.map((bid, index) => (
                      <div 
                        key={`bid-${index}`} 
                        className="flex justify-between items-center py-1.5 border-b border-gray-700/20 relative group hover:bg-green-500/5 transition-colors duration-150"
                        onMouseEnter={(e) => {
                          // Remove any existing tooltips first
                          removeAllTooltips();
                          
                          // Set active tooltip ID
                          const tooltipId = `tooltip-bid-${index}`;
                          setActiveTooltip(tooltipId);
                          
                          // Create and show tooltip with source information
                          const tooltip = document.createElement('div');
                          tooltip.className = 'absolute bg-gray-900/95 backdrop-blur-sm border border-gray-700 rounded-lg p-3 shadow-xl z-10 left-1/2 transform -translate-x-1/2 bottom-full mb-2 w-56';
                          tooltip.id = tooltipId;
                          
                          // Get sources for this price
                          const sources = getSourcesForPrice(bid.price, true);
                          
                          // Create tooltip content
                          let content = '<p class="text-xs font-medium mb-2 text-gray-300">Order Sources:</p>';
                          Object.entries(sources).forEach(([source, size]) => {
                            const percentage = ((size / bid.size) * 100).toFixed(1);
                            content += `<div class="flex justify-between text-xs mb-1">
                              <span class="capitalize text-gray-400">${source}:</span>
                              <span class="font-medium">${size.toFixed(4)} <span class="text-gray-500">(${percentage}%)</span></span>
                            </div>`;
                          });
                          
                          tooltip.innerHTML = content;
                          e.currentTarget.appendChild(tooltip);
                        }}
                        onMouseLeave={() => {
                          // We'll handle tooltip removal in a more robust way
                          setTimeout(() => {
                            if (activeTooltip === `tooltip-bid-${index}`) {
                              removeAllTooltips();
                              setActiveTooltip(null);
                            }
                          }, 50);
                        }}
                      >
                        <span className="text-green-500 font-medium">{formatPrice(bid.price)}</span>
                        <span className="font-medium">{bid.size.toFixed(4)}</span>
                        <div 
                          className="absolute left-0 h-full bg-green-500/10" 
                          style={{ 
                            width: `${Math.min(bid.size / Math.max(...aggregatedOrderBook.bids.map(b => b.size)) * 100, 100)}%`,
                            zIndex: -1 
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                
                {/* Asks */}
                <div className="p-4">
                  <div className="flex justify-between text-sm text-gray-400 mb-2 pb-2 border-b border-gray-700/30">
                    <span>Price (USDT)</span>
                    <span>Size ({selectedTicker})</span>
                  </div>
                  <div className="space-y-1 max-h-[500px] overflow-y-auto custom-scrollbar">
                    {aggregatedOrderBook.asks.map((ask, index) => (
                      <div 
                        key={`ask-${index}`} 
                        className="flex justify-between items-center py-1.5 border-b border-gray-700/20 relative group hover:bg-red-500/5 transition-colors duration-150"
                        onMouseEnter={(e) => {
                          // Remove any existing tooltips first
                          removeAllTooltips();
                          
                          // Set active tooltip ID
                          const tooltipId = `tooltip-ask-${index}`;
                          setActiveTooltip(tooltipId);
                          
                          // Create and show tooltip with source information
                          const tooltip = document.createElement('div');
                          tooltip.className = 'absolute bg-gray-900/95 backdrop-blur-sm border border-gray-700 rounded-lg p-3 shadow-xl z-10 left-1/2 transform -translate-x-1/2 bottom-full mb-2 w-56';
                          tooltip.id = tooltipId;
                          
                          // Get sources for this price
                          const sources = getSourcesForPrice(ask.price, false);
                          
                          // Create tooltip content
                          let content = '<p class="text-xs font-medium mb-2 text-gray-300">Order Sources:</p>';
                          Object.entries(sources).forEach(([source, size]) => {
                            const percentage = ((size / ask.size) * 100).toFixed(1);
                            content += `<div class="flex justify-between text-xs mb-1">
                              <span class="capitalize text-gray-400">${source}:</span>
                              <span class="font-medium">${size.toFixed(4)} <span class="text-gray-500">(${percentage}%)</span></span>
                            </div>`;
                          });
                          
                          tooltip.innerHTML = content;
                          e.currentTarget.appendChild(tooltip);
                        }}
                        onMouseLeave={() => {
                          // We'll handle tooltip removal in a more robust way
                          setTimeout(() => {
                            if (activeTooltip === `tooltip-ask-${index}`) {
                              removeAllTooltips();
                              setActiveTooltip(null);
                            }
                          }, 50);
                        }}
                      >
                        <span className="text-red-500 font-medium">{formatPrice(ask.price)}</span>
                        <span className="font-medium">{ask.size.toFixed(4)}</span>
                        <div 
                          className="absolute right-0 h-full bg-red-500/10" 
                          style={{ 
                            width: `${Math.min(ask.size / Math.max(...aggregatedOrderBook.asks.map(a => a.size)) * 100, 100)}%`,
                            zIndex: -1 
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800/50 p-6 mt-8 bg-black/30 backdrop-blur-sm">
        <div className="container mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="mb-4 md:mb-0">
              <div className="flex items-center">
                <div className="w-8 h-8 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center mr-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                </div>
                <span className="text-lg font-semibold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">Crypto Order Book Aggregator</span>
              </div>
              <p className="text-sm text-gray-500 mt-2">
                For educational purposes only. Not financial advice.
              </p>
            </div>
            <div className="text-center md:text-right">
              <p className="text-sm text-gray-400">Data is aggregated from multiple exchanges and updated in real-time.</p>
              <p className="text-xs text-gray-500 mt-2">© {new Date().getFullYear()} Crypto Order Book Aggregator</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
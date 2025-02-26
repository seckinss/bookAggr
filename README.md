# Crypto Order Book Aggregator

## 📢 Educational Purposes Only

**IMPORTANT DISCLAIMER:** This application is created strictly for **educational and research purposes only**. It is designed to demonstrate how to:

- Connect to multiple cryptocurrency exchange WebSocket APIs
- Aggregate and visualize order book data in real-time
- Build a responsive UI with React and TailwindCSS

**This is NOT financial advice and should NOT be used for actual trading decisions.** The data displayed may not be accurate, complete, or suitable for trading purposes. The creators of this application are not responsible for any financial losses incurred from using this software.

## 🚀 Features

- Real-time order book data from multiple exchanges (Binance, Bybit, OKX, Kucoin, Backpack)
- Aggregated view of bids and asks across all connected exchanges
- Interactive UI with detailed tooltips showing order sources
- Responsive design that works on desktop and mobile devices
- Support for multiple cryptocurrencies (BTC, ETH, SOL, etc.)
- Adjustable order book depth display

## 🏗️ Project Structure

```
/src
  /app                  # Next.js app router
  /webhelpers           # Exchange connection helpers
    /constants          # Constant variables
    /helpers            # Exchange-specific WebSocket handlers
    /types              # TypeScript type definitions
```

## 🚦 Getting Started

First, install the dependencies:

```bash
npm install
# or
yarn install
# or
pnpm install
```

Then, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## 📚 How It Works

The application connects to multiple cryptocurrency exchanges via WebSocket connections to receive real-time order book data. This data is then aggregated, processed, and displayed in a unified interface.

Key components:
1. **Exchange Connectors**: Handle WebSocket connections to each exchange
2. **Data Aggregation**: Combines order book data from all sources
3. **UI Rendering**: Displays the aggregated data in a user-friendly format

---

Created for educational purposes to demonstrate WebSocket connections and real-time data visualization techniques.

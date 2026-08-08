import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { calculateProviders, COUNTRIES, CURRENCIES, SAMPLE_HISTORICAL_TRANSFERS, TARGET_CURRENCY_RATES } from "./src/data/corridors";
import { TransferRecord } from "./src/types";
import { getLiveExchangeRate } from "./src/services/forexService";

// In-memory transfers database
let transfersStore: TransferRecord[] = [...SAMPLE_HISTORICAL_TRANSFERS];

// Initialize Gemini API client safely
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // 1. Calculate Remittance Rates & Comparisons
  app.post("/api/remittance/calculate", async (req, res) => {
    try {
      const { sendAmountUSD = 500, fromCurrency = 'USD', toCountryCode = 'MX' } = req.body;
      const amount = Math.max(1, Number(sendAmountUSD) || 500);

      const country = COUNTRIES.find((c) => c.code === toCountryCode) || COUNTRIES[0];
      const targetCurrencyCode = country.currencyCode;

      // Fetch live FX rate from Forex API
      const forex = await getLiveExchangeRate(fromCurrency, targetCurrencyCode);

      const providers = calculateProviders(amount, targetCurrencyCode, forex.rate);
      const swiftRemit = providers.find((p) => p.isBlockchain) || providers[0];
      const traditionalAvgFee = 25.0 + amount * 0.04;
      const savingsUSD = Math.max(0, traditionalAvgFee - swiftRemit.totalCostUSD);

      res.json({
        sendAmountUSD: amount,
        fromCurrency,
        toCurrency: targetCurrencyCode,
        toCountry: country,
        fxRate: forex.rate,
        isLiveRate: forex.isLive,
        fxRateSource: forex.source,
        fxRateUpdatedAt: forex.updatedAt,
        recipientGets: swiftRemit.recipientGets,
        recipientGetsFormatted: swiftRemit.recipientGetsFormatted,
        blockchainNetworkFeeUSD: swiftRemit.flatFeeUSD,
        totalSenderPaysUSD: amount + swiftRemit.flatFeeUSD,
        savingsVsTraditionalUSD: savingsUSD,
        savingsPercent: Math.round((savingsUSD / traditionalAvgFee) * 100),
        providers,
        traditionalAverageFeeUSD: traditionalAvgFee,
        guaranteedForMinutes: 15,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to calculate rates' });
    }
  });

 
  const handleProcessRemittance = async (req: any, res: any) => {
    try {
      const { sendAmountUSD, fromCurrency, recipientCountryCode, recipientCountry, recipientDetails, paymentMethod } = req.body;
      const amount = Number(sendAmountUSD) || 500;
      const country = COUNTRIES.find((c) => c.code === recipientCountryCode || c.name === recipientCountry) || COUNTRIES[0];
      const targetCurrencyCode = country.currencyCode;

      // Fetch live FX rate from Forex API
      const forex = await getLiveExchangeRate(fromCurrency || 'USD', targetCurrencyCode);

      const recipientGets = amount * forex.rate;
      const txHash = '0x' + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const blockNumber = 48925000 + Math.floor(Math.random() * 5000);
      const id = 'tx_' + Math.random().toString(36).substring(2, 10);

      const providers = calculateProviders(amount, targetCurrencyCode, forex.rate);
      const traditionalCost = providers.find((p) => p.id === 'western_union')?.totalCostUSD || 35;
      const savingsUSD = Math.max(15, traditionalCost - 0.35);

      const newTransfer: TransferRecord = {
        id,
        createdAt: new Date().toISOString(),
        sendAmountUSD: amount,
        fromCurrency: fromCurrency || 'USD',
        recipientGets,
        recipientCurrency: targetCurrencyCode,
        recipientName: recipientDetails?.fullName || 'Valued Recipient',
        recipientCountry: country.name,
        deliveryMethod: recipientDetails?.deliveryMethod || 'bank',
        paymentMethod: paymentMethod || 'Debit Card',
        status: 'completed',
        txHash,
        blockNumber,
        networkFeeUSD: 0.35,
        savingsUSD,
        deliveryTimeSeconds: 3,
        completedAt: new Date().toISOString(),
        recipientDetails: recipientDetails || {
          fullName: 'Valued Recipient',
          emailOrPhone: 'recipient@example.com',
          deliveryMethod: 'bank',
        },
        isLiveRate: forex.isLive,
        fxRateSource: forex.source,
        fxRate: forex.rate,
      };

      transfersStore.unshift(newTransfer);

      res.json({
        success: true,
        transfer: newTransfer,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to process transaction' });
    }
  };

  app.post("/api/remittance/process", handleProcessRemittance);
  app.post("/api/remittance/execute", handleProcessRemittance);

  // 3. Get All Transfers / History
  app.get("/api/remittance/transfers", (req, res) => {
    res.json({ transfers: transfersStore });
  });

  // 4. Get Specific Transfer
  app.get("/api/remittance/transfers/:id", (req, res) => {
    const transfer = transfersStore.find((t) => t.id === req.params.id);
    if (!transfer) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    res.json({ transfer });
  });

  
  app.post("/api/ai/assistant", async (req, res) => {
    try {
      const { prompt, sendContext } = req.body;
      if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Prompt is required' });
      }

      const ai = getGeminiClient();
      if (!ai) {
        return res.json({
          reply: `I can help guide your transfer! Here is a summary based on standard rates:\n\n- **Current Rates**: Our blockchain rail settlement uses true mid-market FX rates with zero spread markup.\n- **Network Cost**: Transfers cost a flat $0.35 (vs. $20–$50 at traditional banks).\n- **Delivery Time**: Under 5 seconds directly to recipient bank accounts, GCash, M-Pesa, or cash pickup points.\n\n*Note: To enable live Gemini AI answers, ensure GEMINI_API_KEY is active in your project settings.*`,
        });
      }

      const contextPrompt = sendContext
        ? `The user is currently considering sending $${sendContext.amount || 500} USD to ${sendContext.countryName || 'Mexico'} (${sendContext.targetCurrency || 'MXN'}).`
        : '';

      const systemInstruction = `You are the SwiftRemit AI Advisor, an expert in international cross-border money transfers, exchange rate trends, local banking rules, and blockchain remittance technology.
Your audience consists of everyday users who want simple, clear, non-technical answers.
Keep explanations warm, encouraging, concise, and structured with clean bullet points when listing steps or recommendations.
Always highlight how blockchain rails eliminate hidden fees and speed up delivery from days to seconds without requiring recipients to know crypto.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: `${contextPrompt}\n\nUser Question: ${prompt}`,
        config: {
          systemInstruction,
        },
      });

      res.json({
        reply: response.text || "I'm here to help with all your international transfer questions!",
      });
    } catch (err: any) {
      console.error('Gemini Assistant Error:', err);
      res.status(500).json({
        error: err?.message || 'Error processing AI query',
        reply: 'Sorry, I ran into an issue looking up that remittance query. Please try again shortly.',
      });
    }
  });

  // Vite middleware for dev or Static Files in Production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();

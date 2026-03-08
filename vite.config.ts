import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const SECURITY_UNIVERSE = [
  { symbol: 'SCHD', name: 'Schwab U.S. Dividend Equity ETF', market: 'OVERSEAS', strategy: 'dividend_growth' },
  { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF', market: 'OVERSEAS', strategy: 'dividend_growth' },
  { symbol: 'JEPI', name: 'JPMorgan Equity Premium Income ETF', market: 'OVERSEAS', strategy: 'covered_call' },
  { symbol: 'VIG', name: 'Vanguard Dividend Appreciation ETF', market: 'OVERSEAS', strategy: 'dividend_growth' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', market: 'OVERSEAS', strategy: 'dividend_growth' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', market: 'OVERSEAS', strategy: 'dividend_growth' },
  { symbol: 'QYLD', name: 'Global X Nasdaq 100 Covered Call ETF', market: 'OVERSEAS', strategy: 'covered_call' },
  { symbol: 'O', name: 'Realty Income Corporation', market: 'OVERSEAS', strategy: 'dividend_growth' },
] as const

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      meta?: { regularMarketPrice?: number }
      indicators?: {
        quote?: Array<{ close?: Array<number | null> }>
        adjclose?: Array<{ adjclose?: Array<number | null> }>
      }
      events?: { dividends?: Record<string, { date?: number; amount?: number }> }
    }>
  }
}

type WorldBankInflationResponse = [unknown, Array<{ date?: string; value?: number | null }>]

let retirementPayloadCache: { payload: unknown; fetchedAt: number } | null = null

const fetchJsonWithTimeout = async <T>(url: string, timeoutMs: number) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`upstream_error_${response.status}`)
    }
    return await response.json() as T
  } finally {
    clearTimeout(timer)
  }
}

const resolveLatestPrice = (marketPrice: unknown, closes: Array<number | null>) => {
  if (typeof marketPrice === 'number' && Number.isFinite(marketPrice)) {
    return marketPrice
  }
  for (let i = closes.length - 1; i >= 0; i -= 1) {
    const close = closes[i]
    if (typeof close === 'number' && Number.isFinite(close)) {
      return close
    }
  }
  return 0
}

const computeCagr = (start: number, end: number, years: number) => {
  if (start <= 0 || end <= 0 || years <= 0) {
    return 0
  }
  return (end / start) ** (1 / years) - 1
}

const isFullYearBucket = (year: number, monthlyCount: number) => {
  const currentYear = new Date().getFullYear()
  return year < currentYear && monthlyCount >= 10
}

const liveDataProxyPlugin = (): Plugin => ({
  name: 'retirement-data-proxy',
  configureServer(server) {
    server.middlewares.use('/api/retirement-data', async (_req, res) => {
      try {
        const [fxCurrentRes, fxHistoryRes, inflationRes, securityResults] = await Promise.all([
          fetchJsonWithTimeout<{ rates?: Record<string, number> }>('https://api.frankfurter.app/latest?from=USD&to=KRW', 3000),
          fetchJsonWithTimeout<{ rates?: Record<string, Record<string, number>> }>('https://api.frankfurter.app/2005-01-01..2026-12-31?from=USD&to=KRW', 4000),
          fetchJsonWithTimeout<WorldBankInflationResponse>('https://api.worldbank.org/v2/country/KOR/indicator/FP.CPI.TOTL.ZG?format=json&per_page=70', 4500),
          Promise.allSettled(
            SECURITY_UNIVERSE.map((security) =>
              fetchJsonWithTimeout<YahooChartResponse>(
                `https://query1.finance.yahoo.com/v8/finance/chart/${security.symbol}?range=max&interval=1mo&events=div`,
                4500,
              ),
            ),
          ),
        ])

        const fxCurrentJson = fxCurrentRes as { rates?: Record<string, number> }
        const fxHistoryJson = fxHistoryRes as { rates?: Record<string, Record<string, number>> }
        const inflationJson = inflationRes as WorldBankInflationResponse
        const currentUsdKrw = fxCurrentJson.rates?.KRW ?? 0
        const yearlyAvgUsdKrw: Record<string, number> = {}
        const yearlyBuckets: Record<string, number[]> = {}
        const rates = fxHistoryJson.rates ?? {}

        Object.entries(rates).forEach(([date, value]) => {
          const year = date.slice(0, 4)
          const fx = typeof value?.KRW === 'number' ? value.KRW : null
          if (!fx) {
            return
          }
          yearlyBuckets[year] = yearlyBuckets[year] ?? []
          yearlyBuckets[year].push(fx)
        })

        Object.entries(yearlyBuckets).forEach(([year, values]) => {
          yearlyAvgUsdKrw[year] = values.reduce((sum, value) => sum + value, 0) / values.length
        })

        const inflationRows = Array.isArray(inflationJson?.[1]) ? inflationJson[1] : []
        const inflationValues = inflationRows
          .map((row) => row.value)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        const recentInflation = inflationValues.slice(0, 10)
        const koreaAvgInflationPct = recentInflation.length > 0
          ? recentInflation.reduce((sum, value) => sum + value, 0) / recentInflation.length
          : 0

        const securityEntries: Array<[string, unknown]> = SECURITY_UNIVERSE.flatMap((security, index) => {
          const result = securityResults[index]
          if (result.status !== 'fulfilled') {
            const fallback = retirementPayloadCache
              ? (retirementPayloadCache.payload as {
                securities?: Record<string, unknown>
              }).securities?.[security.symbol]
              : undefined
            return fallback ? [[security.symbol, fallback]] : []
          }

          const payload = result.value
            const chart = payload.chart?.result?.[0]
            const timestamps = Array.isArray(chart?.timestamp) ? chart.timestamp : []
            const closes = Array.isArray(chart?.indicators?.quote?.[0]?.close) ? chart.indicators?.quote?.[0]?.close ?? [] : []
            const adjustedCloses = Array.isArray(chart?.indicators?.adjclose?.[0]?.adjclose)
              ? chart?.indicators?.adjclose?.[0]?.adjclose ?? []
              : []
            const priceHistory = timestamps
              .map((timestamp, index) => ({
                date: new Date(timestamp * 1000).toISOString().slice(0, 10),
                close: closes[index] ?? adjustedCloses[index],
              }))
              .filter((item): item is { date: string; close: number } => typeof item.close === 'number' && Number.isFinite(item.close))

            const rawDividends = chart?.events?.dividends ?? {}
            const dividendEvents = Object.values(rawDividends)
              .map((item) => ({
                date: typeof item.date === 'number' ? new Date(item.date * 1000).toISOString().slice(0, 10) : '',
                amount: item.amount,
              }))
              .filter((item): item is { date: string; amount: number } => Boolean(item.date) && typeof item.amount === 'number' && Number.isFinite(item.amount))
              .sort((a, b) => a.date.localeCompare(b.date))

            const latestPrice = resolveLatestPrice(chart?.meta?.regularMarketPrice, closes)

            const latestPriceDate = priceHistory[priceHistory.length - 1]?.date
            const ttmDividendCutoff = latestPriceDate
              ? new Date(new Date(latestPriceDate).getTime() - 365 * 24 * 60 * 60 * 1000)
              : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
            const forwardAnnualDividendUsd = dividendEvents
              .filter((item) => new Date(item.date) >= ttmDividendCutoff)
              .reduce((sum, item) => sum + item.amount, 0)

            const dividendByYear = new Map<number, number>()
            const priceByYear = new Map<number, number[]>()
            const monthlyCountByYear = new Map<number, number>()
            priceHistory.forEach((item) => {
              const year = Number(item.date.slice(0, 4))
              const bucket = priceByYear.get(year) ?? []
              bucket.push(item.close)
              priceByYear.set(year, bucket)
              monthlyCountByYear.set(year, (monthlyCountByYear.get(year) ?? 0) + 1)
            })
            dividendEvents.forEach((item) => {
              const year = Number(item.date.slice(0, 4))
              dividendByYear.set(year, (dividendByYear.get(year) ?? 0) + item.amount)
            })
            const dividendYears = Array.from(dividendByYear.entries()).sort((a, b) => a[0] - b[0])

            const fullYears = Array.from(monthlyCountByYear.entries())
              .filter(([year, count]) => isFullYearBucket(year, count))
              .map(([year]) => year)
              .sort((a, b) => a - b)

            const firstFullYear = fullYears[0]
            const lastFullYear = fullYears[fullYears.length - 1]
            const firstFullYearAvgPrice = firstFullYear
              ? (() => {
                const bucket = priceByYear.get(firstFullYear) ?? []
                return bucket.length > 0 ? bucket.reduce((sum, value) => sum + value, 0) / bucket.length : 0
              })()
              : 0
            const lastFullYearAvgPrice = lastFullYear
              ? (() => {
                const bucket = priceByYear.get(lastFullYear) ?? []
                return bucket.length > 0 ? bucket.reduce((sum, value) => sum + value, 0) / bucket.length : 0
              })()
              : 0
            const priceYearsSpan = firstFullYear && lastFullYear
              ? Math.max(1, lastFullYear - firstFullYear)
              : 1
            const priceAvgSinceListingPct = computeCagr(firstFullYearAvgPrice, lastFullYearAvgPrice, priceYearsSpan) * 100

            const dividendYearsFullOnly = dividendYears.filter(([year]) => fullYears.includes(year))
            const firstDividendYear = dividendYearsFullOnly[0]
            const lastDividendYear = dividendYearsFullOnly[dividendYearsFullOnly.length - 1]
            const firstDividend = firstDividendYear?.[1] ?? 0
            const lastDividend = lastDividendYear?.[1] ?? forwardAnnualDividendUsd
            const dividendYearsSpan = firstDividendYear && lastDividendYear
              ? Math.max(1, lastDividendYear[0] - firstDividendYear[0])
              : 1
            const dividendAvgSinceListingPct = computeCagr(firstDividend, lastDividend, dividendYearsSpan) * 100

            const coveredCallYieldSamples = Array.from(dividendByYear.entries())
              .filter(([year]) => fullYears.includes(year))
              .map(([year, annualDividend]) => {
                const closes = priceByYear.get(year) ?? []
                if (closes.length === 0) {
                  return null
                }
                const avgPrice = closes.reduce((sum, value) => sum + value, 0) / closes.length
                if (avgPrice <= 0) {
                  return null
                }
                return (annualDividend / avgPrice) * 100
              })
              .filter((value): value is number => value !== null && Number.isFinite(value))

            const coveredCallYieldAvgSinceListingPct = coveredCallYieldSamples.length > 0
              ? coveredCallYieldSamples.reduce((sum, value) => sum + value, 0) / coveredCallYieldSamples.length
              : 0

            const projectionPriceGrowthPct = Number.isFinite(priceAvgSinceListingPct)
              ? priceAvgSinceListingPct
              : 0

            const projectionDividendGrowthPct = security.strategy === 'covered_call'
              ? 0
              : (Number.isFinite(dividendAvgSinceListingPct) ? dividendAvgSinceListingPct : 0)

            const projectionCoveredCallYieldPct = security.strategy === 'covered_call'
              ? (Number.isFinite(coveredCallYieldAvgSinceListingPct) ? coveredCallYieldAvgSinceListingPct : 0)
              : 0

          return [[security.symbol, {
            symbol: security.symbol,
            name: security.name,
            market: security.market,
            strategy: security.strategy,
            priceUsd: latestPrice,
            forwardAnnualDividendUsd,
            priceAvgSinceListingPct,
            dividendAvgSinceListingPct,
            coveredCallYieldAvgSinceListingPct,
            projectionPriceGrowthPct,
            projectionDividendGrowthPct,
            projectionCoveredCallYieldPct,
            priceHistory,
            dividendEvents,
          }]]
        })

        const securities = Object.fromEntries(securityEntries)

        if (!Number.isFinite(currentUsdKrw) || currentUsdKrw <= 0) {
          if (retirementPayloadCache) {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(retirementPayloadCache.payload))
            return
          }

          res.statusCode = 502
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'fx_error' }))
          return
        }

        if (Object.keys(securities).length === 0 && retirementPayloadCache) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(retirementPayloadCache.payload))
          return
        }

        const payload = {
          asOf: new Date().toLocaleString('ko-KR'),
          fx: {
            currentUsdKrw,
            yearlyAvgUsdKrw,
          },
          inflation: {
            koreaAvg10yPct: koreaAvgInflationPct,
          },
          securities,
        }

        retirementPayloadCache = {
          payload,
          fetchedAt: Date.now(),
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
      } catch {
        if (retirementPayloadCache) {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(retirementPayloadCache.payload))
          return
        }

        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'retirement_data_failed' }))
      }
    })
  },
})

export default defineConfig({
  server: {
    allowedHosts: true,
  },
  plugins: [react(), liveDataProxyPlugin()],
})

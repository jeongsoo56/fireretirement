import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

type TaxPresetKey = 'kr_overseas' | 'kr_domestic' | 'custom'
type FlowKey = 'past' | 'future'

type SecurityData = {
  symbol: string
  name: string
  market: 'OVERSEAS' | 'DOMESTIC'
  strategy: 'dividend_growth' | 'covered_call'
  priceUsd: number
  forwardAnnualDividendUsd: number
  priceAvgSinceListingPct: number
  dividendAvgSinceListingPct: number
  coveredCallYieldAvgSinceListingPct: number
  projectionPriceGrowthPct: number
  projectionDividendGrowthPct: number
  projectionCoveredCallYieldPct: number
  priceHistory: Array<{ date: string; close: number }>
  dividendEvents: Array<{ date: string; amount: number }>
}

type MarketPayload = {
  asOf: string
  fx: {
    currentUsdKrw: number
    yearlyAvgUsdKrw: Record<string, number>
  }
  inflation: {
    koreaAvg10yPct: number
  }
  securities: Record<string, SecurityData>
}

type TaxPreset = {
  label: string
  dividendTaxPct: number
  capitalGainsTaxPct: number
  capitalGainsDeductionKrw: number
  note: string
}

type PastPurchaseRow = {
  id: string
  symbol: string
  buyYear: number
  amountManwon: number
}

type PastHoldingResult = {
  row: PastPurchaseRow
  name: string
  sharesNow: number
  currentValueKrw: number
  annualDividendNetKrw: number
  monthlyDividendNetKrw: number
  investedKrw: number
  buyPriceUsd: number
  buyFx: number
  currentNetYieldPct: number
  costBasisNetYieldPct: number
}

type FutureProjectionRow = {
  year: number
  endValueKrw: number
  endValueP10Krw: number
  endValueP90Krw: number
  endValueRealKrw: number
  annualDividendNetKrw: number
  monthlyDividendNetKrw: number
  monthlyDividendNetP10Krw: number
  monthlyDividendNetP90Krw: number
  monthlyDividendRealKrw: number
  breakdown: Array<{
    planId: string
    symbol: string
    name: string
    endValueKrw: number
    endValueRealKrw: number
    annualDividendNetKrw: number
    monthlyDividendNetKrw: number
    monthlyDividendRealKrw: number
  }>
}

type FuturePlanRow = {
  id: string
  symbol: string
  startManwon: number
  monthlyManwon: number
}

const TAX_PRESETS: Record<TaxPresetKey, TaxPreset> = {
  kr_overseas: {
    label: '한국 해외주식/ETF 기본',
    dividendTaxPct: 15.4,
    capitalGainsTaxPct: 22,
    capitalGainsDeductionKrw: 2500000,
    note: '해외 배당은 한국 투자자 기준 단순화 유효세율 15.4%로 계산하고, 해외 양도차익은 연 250만원 공제 후 22%로 안내합니다.',
  },
  kr_domestic: {
    label: '한국 국내주식/ETF 기본',
    dividendTaxPct: 15.4,
    capitalGainsTaxPct: 0,
    capitalGainsDeductionKrw: 0,
    note: '국내 배당소득세 15.4% 기준. 일반 투자자 장내 양도세는 0으로 단순화합니다.',
  },
  custom: {
    label: '직접 입력',
    dividendTaxPct: 15.4,
    capitalGainsTaxPct: 22,
    capitalGainsDeductionKrw: 2500000,
    note: '직접 세율/공제값을 넣어 계산합니다.',
  },
}

const defaultPastRow = (): PastPurchaseRow => ({
  id: crypto.randomUUID(),
  symbol: 'SCHD',
  buyYear: new Date().getFullYear() - 10,
  amountManwon: 1000,
})

const defaultFutureRow = (): FuturePlanRow => ({
  id: crypto.randomUUID(),
  symbol: 'SCHD',
  startManwon: 1000,
  monthlyManwon: 50,
})

const krwFormatter = new Intl.NumberFormat('ko-KR')
const compactFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 })
const MONTE_CARLO_RUNS = 400

const clampFutureYears = (value: number) => {
  if (!Number.isFinite(value)) {
    return 20
  }
  return Math.max(1, Math.min(100, Math.floor(value)))
}

const hashString = (value: string) => {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

const createSeededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const quantile = (values: number[], p: number) => {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)))
  return sorted[index]
}

const buildMonthlyReturnSamples = (security: SecurityData) => {
  const sortedPrices = [...security.priceHistory].sort((a, b) => a.date.localeCompare(b.date))
  const dividendByMonth = new Map<string, number>()

  security.dividendEvents.forEach((event) => {
    const monthKey = event.date.slice(0, 7)
    dividendByMonth.set(monthKey, (dividendByMonth.get(monthKey) ?? 0) + event.amount)
  })

  const samples: Array<{ priceReturn: number; dividendYield: number }> = []
  for (let i = 1; i < sortedPrices.length; i += 1) {
    const prev = sortedPrices[i - 1].close
    const curr = sortedPrices[i].close
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) {
      continue
    }

    const monthKey = sortedPrices[i].date.slice(0, 7)
    const monthlyDividend = dividendByMonth.get(monthKey) ?? 0
    const priceReturn = curr / prev - 1
    const dividendYield = monthlyDividend / prev

    if (!Number.isFinite(priceReturn) || !Number.isFinite(dividendYield)) {
      continue
    }
    if (priceReturn <= -0.95 || priceReturn >= 5 || dividendYield < -0.5 || dividendYield >= 1) {
      continue
    }

    samples.push({
      priceReturn,
      dividendYield: Math.max(0, dividendYield),
    })
  }

  if (samples.length > 0) {
    return samples
  }

  const fallbackMonthlyPriceReturn = (1 + (security.projectionPriceGrowthPct / 100)) ** (1 / 12) - 1
  const fallbackMonthlyDividendYield = security.priceUsd > 0
    ? Math.max(0, (security.forwardAnnualDividendUsd / security.priceUsd) / 12)
    : 0

  return [{
    priceReturn: Number.isFinite(fallbackMonthlyPriceReturn) ? fallbackMonthlyPriceReturn : 0,
    dividendYield: Number.isFinite(fallbackMonthlyDividendYield) ? fallbackMonthlyDividendYield : 0,
  }]
}

const toKrw = (value: number) => `${krwFormatter.format(Math.round(value))}원`
const toManwon = (value: number) => `${krwFormatter.format(Math.round(value))}만원`
const toPct = (value: number) => `${compactFormatter.format(value)}%`

const pickYearEndPrice = (security: SecurityData, year: number) => {
  const target = `${year}-12-31`
  for (let i = security.priceHistory.length - 1; i >= 0; i -= 1) {
    if (security.priceHistory[i].date <= target) {
      return security.priceHistory[i].close
    }
  }
  return security.priceHistory[0]?.close ?? 0
}

const pickYearAveragePrice = (security: SecurityData, year: number) => {
  const closes = security.priceHistory
    .filter((item) => Number(item.date.slice(0, 4)) === year)
    .map((item) => item.close)

  if (closes.length === 0) {
    return pickYearEndPrice(security, year)
  }

  return closes.reduce((sum, value) => sum + value, 0) / closes.length
}

const findClosestPriceOnOrBefore = (security: SecurityData, date: string) => {
  for (let i = security.priceHistory.length - 1; i >= 0; i -= 1) {
    if (security.priceHistory[i].date <= date) {
      return security.priceHistory[i].close
    }
  }
  return security.priceHistory[0]?.close ?? 0
}

const getSecurityYearBounds = (security: SecurityData) => {
  const years = security.priceHistory
    .map((item) => Number(item.date.slice(0, 4)))
    .filter((year) => Number.isFinite(year))

  if (years.length === 0) {
    const current = new Date().getFullYear()
    return { minYear: current, maxYear: current }
  }

  return {
    minYear: Math.min(...years),
    maxYear: Math.max(...years),
  }
}

function App() {
  const [flow, setFlow] = useState<FlowKey>('past')
  const [taxPreset, setTaxPreset] = useState<TaxPresetKey>('kr_overseas')
  const [customDividendTaxPct, setCustomDividendTaxPct] = useState(15.4)
  const [customCapitalGainsTaxPct, setCustomCapitalGainsTaxPct] = useState(22)
  const [customCapitalDeductionKrw, setCustomCapitalDeductionKrw] = useState(2500000)
  const [showTaxAdvanced, setShowTaxAdvanced] = useState(false)

  const [marketData, setMarketData] = useState<MarketPayload | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [pastRows, setPastRows] = useState<PastPurchaseRow[]>([defaultPastRow()])
  const [pastDrip, setPastDrip] = useState(true)

  const [futureRowsInput, setFutureRowsInput] = useState<FuturePlanRow[]>([defaultFutureRow()])
  const [futureYears, setFutureYears] = useState(20)
  const [futureDrip, setFutureDrip] = useState(true)
  const [showPastFormula, setShowPastFormula] = useState(false)
  const [showFutureFormula, setShowFutureFormula] = useState(false)
  const [expandedFutureYears, setExpandedFutureYears] = useState<number[]>([])
  const [expandAllFutureYears, setExpandAllFutureYears] = useState(false)

  const activeTax = taxPreset === 'custom'
    ? {
      label: TAX_PRESETS.custom.label,
      dividendTaxPct: customDividendTaxPct,
      capitalGainsTaxPct: customCapitalGainsTaxPct,
      capitalGainsDeductionKrw: customCapitalDeductionKrw,
      note: TAX_PRESETS.custom.note,
    }
    : TAX_PRESETS[taxPreset]

  const loadMarketData = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12000)
      let response: Response
      try {
        response = await fetch('/api/retirement-data', { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) {
        throw new Error('시장 데이터를 불러오지 못했습니다.')
      }
      const payload = await response.json() as MarketPayload
      setMarketData(payload)

      const symbols = Object.keys(payload.securities)
      if (symbols.length > 0) {
        setFutureRowsInput((prev) => prev.map((row) => ({
          ...row,
          symbol: payload.securities[row.symbol] ? row.symbol : symbols[0],
        })))
        setPastRows((prev) => prev.map((row) => ({
          ...row,
          symbol: payload.securities[row.symbol] ? row.symbol : symbols[0],
          buyYear: (() => {
            const resolvedSymbol = payload.securities[row.symbol] ? row.symbol : symbols[0]
            const bounds = getSecurityYearBounds(payload.securities[resolvedSymbol])
            return Math.max(bounds.minYear, Math.min(bounds.maxYear, row.buyYear))
          })(),
        })))
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setLoadError('시장 데이터 응답 시간이 길어 중단되었습니다. 잠시 후 다시 시도해 주세요.')
      } else {
        setLoadError(error instanceof Error ? error.message : '시장 데이터를 불러오지 못했습니다.')
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMarketData()
  }, [loadMarketData])

  const securityOptions = useMemo(() => {
    if (!marketData) {
      return [] as SecurityData[]
    }
    return Object.values(marketData.securities)
  }, [marketData])

  const pastResults = useMemo(() => {
    if (!marketData) {
      return [] as PastHoldingResult[]
    }

    return pastRows.flatMap((row) => {
      const security = marketData.securities[row.symbol]
      if (!security) {
        return []
      }

      const buyPriceUsd = pickYearAveragePrice(security, row.buyYear)
      const buyFx = marketData.fx.yearlyAvgUsdKrw[String(row.buyYear)] ?? marketData.fx.currentUsdKrw
      if (buyPriceUsd <= 0 || buyFx <= 0) {
        return []
      }

      let shares = (row.amountManwon * 10000) / buyFx / buyPriceUsd

      const purchaseCutoffDate = `${row.buyYear}-01-01`
      const eligibleDividends = security.dividendEvents
        .filter((event) => event.date >= purchaseCutoffDate)
        .sort((a, b) => a.date.localeCompare(b.date))

      for (const event of eligibleDividends) {
        if (!pastDrip) {
          continue
        }

        const reinvestPriceUsd = findClosestPriceOnOrBefore(security, event.date)
        if (reinvestPriceUsd <= 0) {
          continue
        }

        const netDividendUsd = shares * event.amount * (1 - activeTax.dividendTaxPct / 100)
        shares += netDividendUsd / reinvestPriceUsd
      }

      const currentValueKrw = shares * security.priceUsd * marketData.fx.currentUsdKrw
      const annualDividendGrossKrw = shares * security.forwardAnnualDividendUsd * marketData.fx.currentUsdKrw
      const annualDividendNetKrw = annualDividendGrossKrw * (1 - activeTax.dividendTaxPct / 100)
      const investedKrw = row.amountManwon * 10000
      const capitalGainKrw = Math.max(0, currentValueKrw - investedKrw)
      const sellTaxKrw = activeTax.capitalGainsTaxPct > 0
        ? Math.max(0, capitalGainKrw - activeTax.capitalGainsDeductionKrw) * (activeTax.capitalGainsTaxPct / 100)
        : 0
      const currentNetYieldPct = currentValueKrw > 0 ? (annualDividendNetKrw / currentValueKrw) * 100 : 0
      const costBasisNetYieldPct = investedKrw > 0 ? (annualDividendNetKrw / investedKrw) * 100 : 0

      return [{
        row,
        name: security.name,
        sharesNow: shares,
        currentValueKrw: currentValueKrw - sellTaxKrw,
        annualDividendNetKrw,
        monthlyDividendNetKrw: annualDividendNetKrw / 12,
        investedKrw,
        buyPriceUsd,
        buyFx,
        currentNetYieldPct,
        costBasisNetYieldPct,
      }]
    })
  }, [activeTax.capitalGainsDeductionKrw, activeTax.capitalGainsTaxPct, activeTax.dividendTaxPct, marketData, pastDrip, pastRows])

  const futureRows = useMemo(() => {
    if (!marketData) {
      return [] as FutureProjectionRow[]
    }

    if (futureRowsInput.length === 0 || marketData.fx.currentUsdKrw <= 0) {
      return [] as FutureProjectionRow[]
    }

    const fx = marketData.fx.currentUsdKrw
    const inflationPct = marketData.inflation.koreaAvg10yPct
    const safeFutureYears = clampFutureYears(futureYears)

    const plans = futureRowsInput
      .map((row) => {
        const security = marketData.securities[row.symbol]
        if (!security || security.priceUsd <= 0) {
          return null
        }

        return {
          row,
          security,
          initialShares: row.startManwon * 10000 / fx / Math.max(0.0001, security.priceUsd),
          initialPriceUsd: security.priceUsd,
          monthlyContributionUsd: row.monthlyManwon * 10000 / fx,
          monthlySamples: buildMonthlyReturnSamples(security),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    if (plans.length === 0) {
      return [] as FutureProjectionRow[]
    }

    const yearBuckets = Array.from({ length: safeFutureYears }, () => ({
      endValuesKrw: [] as number[],
      annualDividendsKrw: [] as number[],
      breakdown: new Map<string, {
        symbol: string
        name: string
        endValuesKrw: number[]
        annualDividendsKrw: number[]
      }>(),
    }))

    const seedBasis = JSON.stringify({
      years: safeFutureYears,
      drip: futureDrip,
      tax: activeTax.dividendTaxPct,
      fx,
      asOf: marketData.asOf,
      plans: plans.map((plan) => ({
        id: plan.row.id,
        symbol: plan.row.symbol,
        start: plan.row.startManwon,
        monthly: plan.row.monthlyManwon,
      })),
    })
    const rng = createSeededRandom(hashString(seedBasis))

    for (let run = 0; run < MONTE_CARLO_RUNS; run += 1) {
      const runtimePlans = plans.map((plan) => ({
        row: plan.row,
        security: plan.security,
        shares: plan.initialShares,
        currentPriceUsd: plan.initialPriceUsd,
        monthlyContributionUsd: plan.monthlyContributionUsd,
        monthlySamples: plan.monthlySamples,
      }))

      for (let year = 1; year <= safeFutureYears; year += 1) {
        const perPlanYear = runtimePlans.map((plan) => {
          let annualDividendNetUsd = 0

          for (let month = 0; month < 12; month += 1) {
            const sample = plan.monthlySamples[Math.floor(rng() * plan.monthlySamples.length)]
            const monthlyPriceReturn = sample?.priceReturn ?? 0
            const monthlyDividendYield = Math.max(0, sample?.dividendYield ?? 0)

            const monthlyDividendGrossUsd = plan.shares * plan.currentPriceUsd * monthlyDividendYield
            const monthlyDividendNetUsd = monthlyDividendGrossUsd * (1 - activeTax.dividendTaxPct / 100)
            annualDividendNetUsd += monthlyDividendNetUsd

            if (futureDrip && plan.currentPriceUsd > 0) {
              plan.shares += monthlyDividendNetUsd / plan.currentPriceUsd
            }

            const contributionPriceUsd = plan.currentPriceUsd * Math.max(0.05, 1 + monthlyPriceReturn / 2)
            if (contributionPriceUsd > 0) {
              plan.shares += plan.monthlyContributionUsd / contributionPriceUsd
            }

            plan.currentPriceUsd = Math.max(0.0001, plan.currentPriceUsd * (1 + monthlyPriceReturn))
          }

          return {
            planId: plan.row.id,
            symbol: plan.security.symbol,
            name: plan.security.name,
            endValueKrw: plan.shares * plan.currentPriceUsd * fx,
            annualDividendNetKrw: annualDividendNetUsd * fx,
          }
        })

        const bucket = yearBuckets[year - 1]
        const yearEndValueKrw = perPlanYear.reduce((sum, item) => sum + item.endValueKrw, 0)
        const yearDividendKrw = perPlanYear.reduce((sum, item) => sum + item.annualDividendNetKrw, 0)
        bucket.endValuesKrw.push(yearEndValueKrw)
        bucket.annualDividendsKrw.push(yearDividendKrw)

        perPlanYear.forEach((item) => {
          const existing = bucket.breakdown.get(item.planId)
          if (existing) {
            existing.endValuesKrw.push(item.endValueKrw)
            existing.annualDividendsKrw.push(item.annualDividendNetKrw)
            return
          }

          bucket.breakdown.set(item.planId, {
            symbol: item.symbol,
            name: item.name,
            endValuesKrw: [item.endValueKrw],
            annualDividendsKrw: [item.annualDividendNetKrw],
          })
        })
      }
    }

    return yearBuckets.map((bucket, index) => {
      const year = index + 1
      const inflationFactor = (1 + inflationPct / 100) ** year
      const endValueKrw = quantile(bucket.endValuesKrw, 0.5)
      const endValueP10Krw = quantile(bucket.endValuesKrw, 0.1)
      const endValueP90Krw = quantile(bucket.endValuesKrw, 0.9)
      const annualDividendNetKrw = quantile(bucket.annualDividendsKrw, 0.5)
      const monthlyDividendNetKrw = annualDividendNetKrw / 12
      const monthlyDividendNetP10Krw = quantile(bucket.annualDividendsKrw, 0.1) / 12
      const monthlyDividendNetP90Krw = quantile(bucket.annualDividendsKrw, 0.9) / 12
      const breakdown = Array.from(bucket.breakdown.entries()).map(([planId, item]) => {
        const securityEndValueKrw = quantile(item.endValuesKrw, 0.5)
        const securityAnnualDividendKrw = quantile(item.annualDividendsKrw, 0.5)
        return {
          planId,
          symbol: item.symbol,
          name: item.name,
          endValueKrw: securityEndValueKrw,
          endValueRealKrw: securityEndValueKrw / inflationFactor,
          annualDividendNetKrw: securityAnnualDividendKrw,
          monthlyDividendNetKrw: securityAnnualDividendKrw / 12,
          monthlyDividendRealKrw: securityAnnualDividendKrw / 12 / inflationFactor,
        }
      })

      return {
        year,
        endValueKrw,
        endValueP10Krw,
        endValueP90Krw,
        endValueRealKrw: endValueKrw / inflationFactor,
        annualDividendNetKrw,
        monthlyDividendNetKrw,
        monthlyDividendNetP10Krw,
        monthlyDividendNetP90Krw,
        monthlyDividendRealKrw: monthlyDividendNetKrw / inflationFactor,
        breakdown,
      }
    })
  }, [activeTax.dividendTaxPct, futureDrip, futureRowsInput, futureYears, marketData])

  const futureLast = futureRows[futureRows.length - 1] ?? null
  const visibleExpandedYears = expandAllFutureYears ? futureRows.map((row) => row.year) : expandedFutureYears
  const totalPastMonthlyNet = pastResults.reduce((sum, item) => sum + item.monthlyDividendNetKrw, 0)
  const totalPastValue = pastResults.reduce((sum, item) => sum + item.currentValueKrw, 0)

  const updatePastRow = (id: string, patch: Partial<PastPurchaseRow>) => {
    setPastRows((prev) => prev.map((row) => {
      if (row.id !== id) {
        return row
      }

      const next = { ...row, ...patch }
      if (!marketData) {
        return next
      }

      const security = marketData.securities[next.symbol]
      if (!security) {
        return next
      }

      const bounds = getSecurityYearBounds(security)
      return {
        ...next,
        buyYear: Math.max(bounds.minYear, Math.min(bounds.maxYear, next.buyYear)),
      }
    }))
  }

  const addPastRow = () => {
    const fallbackSymbol = securityOptions[0]?.symbol ?? 'SCHD'
    const fallbackSecurity = marketData?.securities[fallbackSymbol]
    const bounds = fallbackSecurity ? getSecurityYearBounds(fallbackSecurity) : null
    setPastRows((prev) => [...prev, {
      ...defaultPastRow(),
      symbol: fallbackSymbol,
      buyYear: bounds ? bounds.maxYear : defaultPastRow().buyYear,
    }])
  }

  const removePastRow = (id: string) => {
    setPastRows((prev) => (prev.length > 1 ? prev.filter((row) => row.id !== id) : prev))
  }

  const updateFutureRow = (id: string, patch: Partial<FuturePlanRow>) => {
    setFutureRowsInput((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const addFutureRow = () => {
    const fallbackSymbol = securityOptions[0]?.symbol ?? 'SCHD'
    setFutureRowsInput((prev) => [...prev, { ...defaultFutureRow(), symbol: fallbackSymbol }])
  }

  const removeFutureRow = (id: string) => {
    setFutureRowsInput((prev) => prev.filter((row) => row.id !== id))
  }

  const toggleFutureYear = (year: number) => {
    setExpandedFutureYears((prev) => prev.includes(year) ? prev.filter((item) => item !== year) : [...prev, year])
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <span className="eyebrow">게으른 은퇴자들을 위한 은퇴계산기</span>
          <h1>주식 한 종목만 골라도, 지금 은퇴소득이 얼마인지 바로 보는 한국형 페이지</h1>
          <p>
            한국 투자자 기준 세금·환율·최신 시세를 반영해서,
            <strong> 과거 매수 결과</strong>와 <strong>지금부터의 미래 소득</strong>을 각각 계산합니다.
          </p>
        </div>
        <div className="hero-side">
          <p>{isLoading ? '시장 데이터 불러오는 중...' : loadError ? `데이터 로드 실패: ${loadError}` : `시장 기준시각: ${marketData?.asOf ?? '-'}`}</p>
          <p>USD/KRW: {marketData ? toKrw(marketData.fx.currentUsdKrw).replace('원', '') : '-'}</p>
          <button type="button" onClick={() => void loadMarketData()} disabled={isLoading}>
            {isLoading ? '새로 불러오는 중...' : '최신 자료 다시 불러오기'}
          </button>
        </div>
      </header>

      <section className="panel">
        <h2>한국 세금 기본값</h2>
        <div className="grid compact">
          <label>
            세금 프리셋
            <select value={taxPreset} onChange={(event) => setTaxPreset(event.target.value as TaxPresetKey)}>
              <option value="kr_overseas">{TAX_PRESETS.kr_overseas.label}</option>
              <option value="kr_domestic">{TAX_PRESETS.kr_domestic.label}</option>
              <option value="custom">{TAX_PRESETS.custom.label}</option>
            </select>
          </label>
          <label>
            유효 배당세율 (%)
            <input
              type="number"
              step="0.1"
              value={taxPreset === 'custom' ? customDividendTaxPct : activeTax.dividendTaxPct}
              onChange={(event) => setCustomDividendTaxPct(Number(event.target.value))}
              disabled={taxPreset !== 'custom'}
            />
          </label>
        </div>
        <p className="note">{activeTax.note}</p>
        <button className="ghost-button" type="button" onClick={() => setShowTaxAdvanced((prev) => !prev)}>
          {showTaxAdvanced ? '세금 고급설정 접기' : '세금 고급설정 보기'}
        </button>
        {showTaxAdvanced ? (
          <div className="grid compact extra-top">
            <label>
              해외 양도세율 (%)
              <input
                type="number"
                step="0.1"
                value={taxPreset === 'custom' ? customCapitalGainsTaxPct : activeTax.capitalGainsTaxPct}
                onChange={(event) => setCustomCapitalGainsTaxPct(Number(event.target.value))}
                disabled={taxPreset !== 'custom'}
              />
            </label>
            <label>
              양도차익 공제액 (원)
              <input
                type="number"
                value={taxPreset === 'custom' ? customCapitalDeductionKrw : activeTax.capitalGainsDeductionKrw}
                onChange={(event) => setCustomCapitalDeductionKrw(Number(event.target.value))}
                disabled={taxPreset !== 'custom'}
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="panel mode-panel">
        <button type="button" className={flow === 'past' ? 'mode-button active' : 'mode-button'} onClick={() => setFlow('past')}>
          1. 과거에 샀다면 지금 얼마일까
        </button>
        <button type="button" className={flow === 'future' ? 'mode-button active' : 'mode-button'} onClick={() => setFlow('future')}>
          2. 지금부터 사면 앞으로 얼마가 될까
        </button>
      </section>

      {flow === 'past' ? (
        <>
          <section className="panel">
            <h2>과거 매수 입력</h2>
            <p className="note">몇 년도에, 어떤 종목을, 얼마 샀는지 입력하면 지금 평가금액과 세후 배당을 계산합니다.</p>
            <p className="note">과거 배당 재투자는 실제 배당 이벤트 날짜를 따라가며 계산합니다. 다만 입력이 연도 단위라 최초 매수단가는 해당 연도 평균 가격으로 잡습니다.</p>
            <div className="check-row">
              <label className="check-label">
                <input type="checkbox" checked={pastDrip} onChange={(event) => setPastDrip(event.target.checked)} />
                배당 재투자까지 반영
              </label>
            </div>
            <div className="stack">
              {pastRows.map((row) => (
                (() => {
                  const selectedSecurity = marketData?.securities[row.symbol]
                  const bounds = selectedSecurity
                    ? getSecurityYearBounds(selectedSecurity)
                    : { minYear: row.buyYear, maxYear: row.buyYear }

                  return (
                    <div key={row.id} className="purchase-row">
                      <label>
                        종목
                        <select value={row.symbol} onChange={(event) => updatePastRow(row.id, { symbol: event.target.value })}>
                          {securityOptions.map((security) => (
                            <option key={security.symbol} value={security.symbol}>{security.symbol} · {security.name}</option>
                          ))}
                        </select>
                      </label>
                      <label>
                        매수연도 ({bounds.minYear}~{bounds.maxYear})
                        <input
                          type="range"
                          min={bounds.minYear}
                          max={bounds.maxYear}
                          step={1}
                          value={row.buyYear}
                          onChange={(event) => updatePastRow(row.id, { buyYear: Number(event.target.value) })}
                        />
                        <small className="range-value">{row.buyYear}년</small>
                      </label>
                      <label>
                        매수금액 (만원)
                        <input type="number" value={row.amountManwon} onChange={(event) => updatePastRow(row.id, { amountManwon: Number(event.target.value) })} />
                      </label>
                      <button type="button" className="ghost-button danger" onClick={() => removePastRow(row.id)}>삭제</button>
                    </div>
                  )
                })()
              ))}
            </div>
            <button type="button" className="ghost-button extra-top" onClick={addPastRow}>매수내역 한 줄 추가</button>
          </section>

          <section className="panel">
            <h2>현재 은퇴소득 결과</h2>
            <div className="stats">
              <article>
                <span>현재 총 평가금액</span>
                <strong>{toManwon(totalPastValue / 10000)}</strong>
                <small>{toKrw(totalPastValue)}</small>
              </article>
              <article>
                <span>세후 월 배당</span>
                <strong>{toManwon(totalPastMonthlyNet / 10000)}</strong>
                <small>{toKrw(totalPastMonthlyNet)}</small>
              </article>
            </div>
            <div className="table-wrap extra-top">
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>매수연도</th>
                    <th>매수금액</th>
                    <th>매수단가(USD)</th>
                    <th>매수환율</th>
                    <th>현재 보유수량</th>
                    <th>현재 평가금액</th>
                    <th>연 세후배당</th>
                    <th>월 세후배당</th>
                    <th>원가 기준 배당률(세후)</th>
                    <th>현재가 기준 배당률(세후)</th>
                  </tr>
                </thead>
                <tbody>
                  {pastResults.length === 0 ? (
                    <tr><td colSpan={11}>데이터를 기다리는 중입니다.</td></tr>
                  ) : pastResults.map((item) => (
                    <tr key={item.row.id}>
                      <td>{item.row.symbol} · {item.name}</td>
                      <td>{item.row.buyYear}년</td>
                      <td>{toManwon(item.row.amountManwon)}</td>
                      <td>${compactFormatter.format(item.buyPriceUsd)}</td>
                      <td>{krwFormatter.format(Math.round(item.buyFx))}</td>
                      <td>{compactFormatter.format(item.sharesNow)}주</td>
                      <td>{toKrw(item.currentValueKrw)}</td>
                      <td>{toKrw(item.annualDividendNetKrw)}</td>
                      <td>{toKrw(item.monthlyDividendNetKrw)}</td>
                      <td>{toPct(item.costBasisNetYieldPct)}</td>
                      <td>{toPct(item.currentNetYieldPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="formula-block">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowPastFormula((prev) => !prev)}
              >
                {showPastFormula ? '자세한 계산식 접기' : '자세하게 알아보기'}
              </button>
              {showPastFormula ? (
                <div className="formula-card extra-top">
                  <h3>과거 매수 → 현재 금액/배당 계산식</h3>
                  <p>아래 식은 현재 코드와 동일한 순서로 계산됩니다.</p>
                  <pre>{`1) 초기 매수 수량
초기수량 = (매수금액(만원) × 10,000) ÷ (매수연도 평균환율) ÷ (매수연도 평균주가)

2) 배당 재투자(옵션 ON일 때)
각 배당 이벤트마다:
세후배당(USD) = 현재수량 × 이벤트배당금(USD/주) × (1 - 배당세율)
재투자수량 = 세후배당(USD) ÷ 해당일(또는 직전일) 주가
현재수량 = 현재수량 + 재투자수량

3) 현재 평가금액
총평가금액(원, 세전) = 현재수량 × 현재주가(USD) × 현재환율
표시평가금액(원, 세후가정) = 총평가금액 - 양도세추정(해당 시)

4) 현재 세후 배당
연세후배당(원) = 현재수량 × 최근12개월배당합(USD/주) × 현재환율 × (1 - 배당세율)
월세후배당(원) = 연세후배당 ÷ 12

5) 표시용 배당률
원가기준배당률(세후) = 연세후배당 ÷ 원금(매수금액)
현재가기준배당률(세후) = 연세후배당 ÷ 총평가금액(세전)`}</pre>
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="panel">
            <h2>지금부터의 매수 계획</h2>
            <p className="note">단일 종목이 아니라 여러 종목을 동시에 담아서 미래 포트폴리오 기준으로 계산합니다.</p>
            <p className="note">미래 계산은 과거 월별 실제 가격·배당 데이터를 부트스트랩(무작위 재표본)해 400회 시뮬레이션하고, 표에는 중앙값(P50)과 불확실성 구간(P10~P90)을 함께 보여줍니다.</p>
            <div className="stack">
              {futureRowsInput.length === 0 ? (
                <p className="note">등록된 종목이 없습니다. 아래 버튼으로 종목을 추가해 주세요.</p>
              ) : null}
              {futureRowsInput.map((row) => {
                const selectedSecurity = marketData?.securities[row.symbol]
                return (
                  <div key={row.id} className="purchase-row future-row">
                    <label>
                      종목
                      <select value={row.symbol} onChange={(event) => updateFutureRow(row.id, { symbol: event.target.value })}>
                        {securityOptions.map((security) => (
                          <option key={security.symbol} value={security.symbol}>{security.symbol} · {security.name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      시작금 (만원)
                      <input type="number" value={row.startManwon} onChange={(event) => updateFutureRow(row.id, { startManwon: Number(event.target.value) })} />
                    </label>
                    <label>
                      월 추가매수 (만원)
                      <input type="number" value={row.monthlyManwon} onChange={(event) => updateFutureRow(row.id, { monthlyManwon: Number(event.target.value) })} />
                    </label>
                    <button type="button" className="ghost-button danger" onClick={() => removeFutureRow(row.id)}>삭제</button>
                    {selectedSecurity ? (
                      <div className="market-pill-row full-row">
                        <span>{selectedSecurity.symbol} 현재가 {toKrw(selectedSecurity.priceUsd * marketData.fx.currentUsdKrw)}</span>
                        <span>최근 12개월 배당합 {toKrw(selectedSecurity.forwardAnnualDividendUsd * marketData.fx.currentUsdKrw)}</span>
                        {selectedSecurity.strategy === 'covered_call' ? (
                          <span>상장후 분배율 평균 {toPct(selectedSecurity.coveredCallYieldAvgSinceListingPct)} (적용 {toPct(selectedSecurity.projectionCoveredCallYieldPct)})</span>
                        ) : (
                          <span>상장후 배당 성장 평균 {toPct(selectedSecurity.dividendAvgSinceListingPct)} (적용 {toPct(selectedSecurity.projectionDividendGrowthPct)})</span>
                        )}
                        <span>상장후 평균 기반 가정치: 가격 {toPct(selectedSecurity.projectionPriceGrowthPct)}</span>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <button type="button" className="ghost-button extra-top" onClick={addFutureRow}>미래 매수 종목 추가</button>
            <div className="grid compact extra-top">
              <label>
                몇 년 볼까
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={futureYears}
                  onChange={(event) => setFutureYears(clampFutureYears(Number(event.target.value)))}
                />
              </label>
              <label>
                한국 10년 평균 물가상승률
                <input type="text" value={toPct(marketData?.inflation.koreaAvg10yPct ?? 0)} readOnly />
              </label>
            </div>
            <div className="check-row">
              <label className="check-label">
                <input type="checkbox" checked={futureDrip} onChange={(event) => setFutureDrip(event.target.checked)} />
                배당 재투자까지 반영
              </label>
            </div>
          </section>

          <section className="panel">
            <h2>미래 은퇴소득 결과</h2>
            <div className="stats">
              <article>
                <span>{futureYears}년 뒤 총 자산</span>
                <strong>{futureLast ? toManwon(futureLast.endValueKrw / 10000) : '-'}</strong>
                <small>{futureLast ? `현재 구매력 ${toKrw(futureLast.endValueRealKrw)} · 보수 ${toKrw(futureLast.endValueP10Krw)} / 보통 ${toKrw(futureLast.endValueKrw)} / 낙관 ${toKrw(futureLast.endValueP90Krw)}` : '-'}</small>
              </article>
              <article>
                <span>{futureYears}년 뒤 세후 월 배당</span>
                <strong>{futureLast ? toManwon(futureLast.monthlyDividendNetKrw / 10000) : '-'}</strong>
                <small>{futureLast ? `현재 구매력 ${toKrw(futureLast.monthlyDividendRealKrw)} · 보수 ${toKrw(futureLast.monthlyDividendNetP10Krw)} / 보통 ${toKrw(futureLast.monthlyDividendNetKrw)} / 낙관 ${toKrw(futureLast.monthlyDividendNetP90Krw)}` : '-'}</small>
              </article>
            </div>
            <div className="table-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setExpandAllFutureYears((prev) => !prev)}
              >
                {expandAllFutureYears ? '전체 접기' : '전체 펼치기'}
              </button>
              <p className="note">연도 칸을 눌러 해당 해의 종목별 상세를 볼 수 있습니다.</p>
            </div>
            <div className="table-wrap extra-top">
              <table className="yearly-table">
                <thead>
                  <tr>
                    <th>연도</th>
                    <th>종료 총자산(명목)</th>
                    <th>종료 총자산(보수·보통·낙관)</th>
                    <th>종료 총자산(현재구매력)</th>
                    <th>연 세후배당</th>
                    <th>월 세후배당(명목)</th>
                    <th>월 세후배당(보수·보통·낙관)</th>
                    <th>월 세후배당(현재구매력)</th>
                  </tr>
                </thead>
                <tbody>
                  {futureRows.length === 0 ? (
                    <tr><td colSpan={8}>데이터를 기다리는 중입니다.</td></tr>
                  ) : futureRows.flatMap((row) => {
                    const isExpanded = expandAllFutureYears || visibleExpandedYears.includes(row.year)
                    return [
                      <tr key={`summary-${row.year}`} className="summary-row">
                        <td>
                          <button type="button" className="year-button" onClick={() => toggleFutureYear(row.year)}>
                            <span className="year-chip">{row.year}년차</span>
                          </button>
                        </td>
                        <td>{toKrw(row.endValueKrw)}</td>
                        <td>{toKrw(row.endValueP10Krw)} / {toKrw(row.endValueKrw)} / {toKrw(row.endValueP90Krw)}</td>
                        <td>{toKrw(row.endValueRealKrw)}</td>
                        <td>{toKrw(row.annualDividendNetKrw)}</td>
                        <td>{toKrw(row.monthlyDividendNetKrw)}</td>
                        <td>{toKrw(row.monthlyDividendNetP10Krw)} / {toKrw(row.monthlyDividendNetKrw)} / {toKrw(row.monthlyDividendNetP90Krw)}</td>
                        <td>{toKrw(row.monthlyDividendRealKrw)}</td>
                      </tr>,
                      ...(isExpanded
                        ? row.breakdown.map((item) => (
                          <tr key={`detail-${row.year}-${item.planId}`} className="detail-row">
                            <td className="detail-label">ㄴ {item.symbol}</td>
                            <td>{toKrw(item.endValueKrw)}</td>
                            <td>-</td>
                            <td>{toKrw(item.endValueRealKrw)}</td>
                            <td>{toKrw(item.annualDividendNetKrw)}</td>
                            <td>{toKrw(item.monthlyDividendNetKrw)}</td>
                            <td>-</td>
                            <td>{toKrw(item.monthlyDividendRealKrw)}</td>
                          </tr>
                        ))
                        : []),
                    ]
                  })}
                </tbody>
              </table>
            </div>
            <div className="formula-block">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setShowFutureFormula((prev) => !prev)}
              >
                {showFutureFormula ? '자세한 계산식 접기' : '자세하게 알아보기'}
              </button>
              {showFutureFormula ? (
                <div className="formula-card extra-top">
                  <h3>미래 예측 산출 계산식</h3>
                  <p>아래 식은 코드의 월 단위 부트스트랩 시뮬레이션과 동일합니다.</p>
                  <pre>{`입력 정의
초기수량 = (시작금(만원) × 10,000) ÷ 현재환율 ÷ 현재주가
월추가매수(USD) = 월추가매수(만원) × 10,000 ÷ 현재환율
월표본 = 과거 월별 {가격수익률 r_m, 배당수익률 y_m}

1회 시뮬레이션의 월 반복(매년 12회)
1) 월 표본 추출
{r_t, y_t} ~ 과거 월표본(복원추출)

2) 월 배당(세후)
월세전배당(USD) = 수량 × 현재주가 × max(0, y_t)
월세후배당(USD) = 월세전배당 × (1 - 배당세율)

3) DRIP(옵션 ON)
재투자수량 = 월세후배당 ÷ 현재주가
수량 = 수량 + 재투자수량

4) 월 추가매수
매수적용단가(USD) = 현재주가 × max(0.05, 1 + r_t / 2)
추가수량 = 월추가매수(USD) ÷ 매수적용단가
수량 = 수량 + 추가수량

5) 월말 가격 갱신
현재주가 = 현재주가 × (1 + r_t)

연말 집계(각 시뮬레이션)
연말자산(원) = 수량 × 현재주가 × 현재환율
연세후배당(원) = 12개월 월세후배당(USD) 합 × 현재환율

최종 표시값
400회 시뮬레이션의 중앙값(P50)을 보통값으로 표시
보수=P10, 보통=P50, 낙관=P90으로 표시
실질값(현재구매력) = 명목값 ÷ (1 + 물가상승률)^연차`}</pre>
                </div>
              ) : null}
            </div>
          </section>
        </>
      )}

      <section className="panel">
        <h2>은퇴자들이 자주 보는 종목</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>종목</th>
                <th>현재가</th>
                <th>최근 12개월 배당/주</th>
                <th>Forward 배당률</th>
                <th>상장후 가격 연평균</th>
                <th>상장후 분배/배당 평균</th>
                <th>투영 가정치</th>
              </tr>
            </thead>
            <tbody>
              {securityOptions.map((security) => {
                const forwardYield = security.priceUsd > 0
                  ? (security.forwardAnnualDividendUsd / security.priceUsd) * 100
                  : 0
                return (
                  <tr key={security.symbol}>
                    <td>{security.symbol} · {security.name}</td>
                    <td>{toKrw(security.priceUsd * (marketData?.fx.currentUsdKrw ?? 0))}</td>
                    <td>{toKrw(security.forwardAnnualDividendUsd * (marketData?.fx.currentUsdKrw ?? 0))}</td>
                    <td>{toPct(forwardYield)}</td>
                    <td>{toPct(security.priceAvgSinceListingPct)}</td>
                    <td>{toPct(security.strategy === 'covered_call' ? security.coveredCallYieldAvgSinceListingPct : security.dividendAvgSinceListingPct)}</td>
                    <td>{security.strategy === 'covered_call' ? `가격 ${toPct(security.projectionPriceGrowthPct)} / 분배율 ${toPct(security.projectionCoveredCallYieldPct)}` : `가격 ${toPct(security.projectionPriceGrowthPct)} / 배당성장 ${toPct(security.projectionDividendGrowthPct)}`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

export default App

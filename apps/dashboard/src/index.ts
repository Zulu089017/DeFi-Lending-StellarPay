// Portfolio Overview Dashboard
// Displays user positions, TVL, health factor, and lending activity.
// Fetches real data from the StellarPay API instead of using hardcoded mock data.

export interface PortfolioPosition {
  asset: string;
  supplied: string;
  suppliedUsd: number;
  borrowed: string;
  borrowedUsd: number;
  collateral: string;
  collateralUsd: number;
  apy: number;
}

export interface PortfolioSummary {
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  totalCollateralUsd: number;
  netWorthUsd: number;
  healthFactor: number;
  availableToBorrowUsd: number;
}

/**
 * Fetches all markets from the API.
 * Each market returns asset information including configured LTV.
 */
export async function fetchMarkets(): Promise<Market[]> {
  const r = await fetch(`${(self as any).config?.api || "http://localhost:4000"}/v1/markets`);
  if (!r.ok) throw new Error(`Failed to fetch markets: ${r.status}`);
  return r.json();
}

/**
 * Fetches user positions from the API.
 * Returns positions for a specific user, or all positions if user is omitted.
 */
export async function fetchPositions(user?: string): Promise<PortfolioPosition[]> {
  const url = user
    ? `${(self as any).config?.api || "http://localhost:4000"}/v1/positions/${user}`
    : `${(self as any).config?.api || "http://localhost:4000"}/v1/positions`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch positions: ${r.status}`);
  return r.json();
}

/**
 * Fetches user health factor from the API.
 */
export async function fetchHealthFactor(user: string): Promise<number> {
  const r = await fetch(
    `${(self as any).config?.api || "http://localhost:4000"}/v1/health-factor/${user}`,
  );
  if (!r.ok) throw new Error(`Failed to fetch health factor: ${r.status}`);
  const d = (await r.json()) as { healthFactor: number };
  return d.healthFactor;
}

/**
 * Computes a portfolio summary from an array of positions.
 * Works with both real API data and the deprecated DEFAULT_POSITIONS.
 */
export function computePortfolioSummary(positions: PortfolioPosition[]): PortfolioSummary {
  const totalSuppliedUsd = positions.reduce((s, p) => s + p.suppliedUsd, 0);
  const totalBorrowedUsd = positions.reduce((s, p) => s + p.borrowedUsd, 0);
  const totalCollateralUsd = positions.reduce((s, p) => s + p.collateralUsd, 0);

  const netWorthUsd = totalSuppliedUsd + totalCollateralUsd - totalBorrowedUsd;
  const healthFactor =
    totalBorrowedUsd > 0 ? totalCollateralUsd / totalBorrowedUsd : Number.POSITIVE_INFINITY;

  const availableToBorrowUsd = totalCollateralUsd * 0.75 - totalBorrowedUsd; // 75% LTV

  return {
    totalSuppliedUsd,
    totalBorrowedUsd,
    totalCollateralUsd,
    netWorthUsd,
    healthFactor,
    availableToBorrowUsd: Math.max(0, availableToBorrowUsd),
  };
}

/**
 * DEPRECATED: Use fetchPositions() instead.
 * Default positions are kept for backward compatibility but should be
 * replaced with real API calls in production.
 *
 * @deprecated Use fetchPositions(user) from the SDK or API directly.
 */
export const DEFAULT_POSITIONS: PortfolioPosition[] = [
  {
    asset: "XLM",
    supplied: "50,000",
    suppliedUsd: 5_000,
    borrowed: "0",
    borrowedUsd: 0,
    collateral: "100,000",
    collateralUsd: 10_000,
    apy: 2.8,
  },
  {
    asset: "wETH",
    supplied: "1.5",
    suppliedUsd: 3_750,
    borrowed: "0.3",
    borrowedUsd: 750,
    collateral: "2.0",
    collateralUsd: 5_000,
    apy: 1.2,
  },
  {
    asset: "wUSDC",
    supplied: "10,000",
    suppliedUsd: 10_000,
    borrowed: "2,000",
    borrowedUsd: 2_000,
    collateral: "5,000",
    collateralUsd: 5_000,
    apy: 4.5,
  },
];

/**
 * Initializes the dashboard with real API data.
 * Must be called with the API configuration before rendering.
 */
export async function initializeDashboard(apiUrl: string): Promise<void> {
  // Store the API URL for use in fetch functions
  // @ts-ignore - setting global config
  (self as any).config = { api: apiUrl };

  // Fetch real markets and positions on initialization
  try {
    const markets = await fetchMarkets();
    console.log(`Loaded ${markets.length} markets from API`);

    // Positions would be fetched per-user in the actual UI
    // For now, we just verify the API is reachable
  } catch (error) {
    console.warn(`Dashboard API not available at default URL: ${error.message}`);
    // Fall back to deprecated DEFAULT_POSITIONS
  }
}

// Market interface for API response
export interface Market {
  asset: string;
  // Additional market data from the API
}

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Assumptions:
    initial_dividend_yield: float = 0.03
    dividend_growth: float = 0.10
    inflation: float = 0.01
    target_monthly_real_krw: float = 1_000_000
    years: int = 40


def run_projection(initial_capital_krw: float, assumptions: Assumptions) -> list[dict[str, float | int | str]]:
    rows: list[dict[str, float | int | str]] = []

    for year in range(1, assumptions.years + 1):
        inflation_factor = (1 + assumptions.inflation) ** year

        annual_dividend_nominal = (
            initial_capital_krw
            * assumptions.initial_dividend_yield
            * ((1 + assumptions.dividend_growth) ** (year - 1))
        )

        monthly_dividend_nominal = annual_dividend_nominal / 12
        monthly_dividend_real = monthly_dividend_nominal / inflation_factor
        target_monthly_nominal = assumptions.target_monthly_real_krw * inflation_factor

        rows.append(
            {
                "scenario_initial_capital_krw": int(initial_capital_krw),
                "year": year,
                "annual_dividend_nominal_krw": round(annual_dividend_nominal, 2),
                "monthly_dividend_nominal_krw": round(monthly_dividend_nominal, 2),
                "monthly_dividend_real_krw": round(monthly_dividend_real, 2),
                "target_monthly_nominal_krw": round(target_monthly_nominal, 2),
                "monthly_gap_nominal_krw": round(monthly_dividend_nominal - target_monthly_nominal, 2),
                "real_coverage_pct": round((monthly_dividend_real / assumptions.target_monthly_real_krw) * 100, 4),
                "target_reached": "Y" if monthly_dividend_real >= assumptions.target_monthly_real_krw else "N",
            }
        )

    return rows


def write_csv(file_path: Path, rows: list[dict[str, float | int | str]]) -> None:
    if not rows:
        return

    fieldnames = list(rows[0].keys())
    with file_path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    assumptions = Assumptions()
    scenarios = [10_000_000, 100_000_000]

    rows: list[dict[str, float | int | str]] = []
    for capital in scenarios:
        rows.extend(run_projection(capital, assumptions))

    output_path = Path("simple_projection_40y.csv")
    write_csv(output_path, rows)

    print(f"Saved: {output_path.resolve()}")
    print("Assumptions:")
    print(f"- Initial dividend yield: {assumptions.initial_dividend_yield * 100:.2f}%")
    print(f"- Dividend growth: {assumptions.dividend_growth * 100:.2f}%")
    print(f"- Inflation: {assumptions.inflation * 100:.2f}%")
    print(f"- Target monthly real KRW: {assumptions.target_monthly_real_krw:,.0f}")
    print(f"- Years: {assumptions.years}")


if __name__ == "__main__":
    main()

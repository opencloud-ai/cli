const scales: Record<string, number> = { file_bytes: 9, ai_cost: 9 };
export function displayAllowance(metric: string, value: string | null): string {
  if (value === null) return "";
  const scale = scales[metric] ?? 0;
  if (!scale) return value;
  const padded = value.padStart(scale + 1, "0");
  return (padded.slice(0, -scale) + "." + padded.slice(-scale)).replace(/\.?0+$/, "");
}
export function parseAllowance(metric: string, value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Enter a non-negative number or leave empty for unlimited.");
  const scale = scales[metric] ?? 0;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale) throw new Error("The value has too many decimal places.");
  const result = BigInt(whole! + fraction.padEnd(scale, "0")).toString();
  if (result.length > 40) throw new Error("The value is too large.");
  return result;
}

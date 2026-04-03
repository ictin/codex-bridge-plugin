const DEFAULT_RISK_PATTERNS = [
  "\\bfix\\b",
  "\\bchange\\b",
  "\\bedit\\b",
  "\\bmodify\\b",
  "\\bwrite\\b",
  "\\bcreate file\\b",
  "\\bdelete\\b",
  "\\bremove\\b",
  "\\brm\\b",
  "\\binstall\\b",
  "\\bnpm install\\b",
  "\\bpnpm install\\b",
  "\\byarn add\\b",
  "\\bpip install\\b",
  "\\brun tests?\\b",
  "\\bpytest\\b",
  "\\bjest\\b",
  "\\bvitest\\b",
  "\\bgit\\b",
  "\\bcommit\\b"
];

export function getRiskPatterns(pluginConfig) {
  const configured = pluginConfig?.approval?.riskHeuristics;
  if (!Array.isArray(configured) || configured.length === 0) {
    return DEFAULT_RISK_PATTERNS;
  }
  return configured.map((entry) => String(entry)).filter(Boolean);
}

export function isApprovalEnabled(pluginConfig) {
  return pluginConfig?.approval?.enabled === true;
}

export function requiresApproval(prompt, pluginConfig) {
  const text = String(prompt || "").trim().toLowerCase();
  if (!text) return false;

  const patterns = getRiskPatterns(pluginConfig);
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(text);
    } catch {
      return text.includes(pattern.toLowerCase());
    }
  });
}

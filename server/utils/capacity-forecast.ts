import type { CapacityRecommendation, ForecastConstraint } from "~/server/utils/analytics-types.ts";

export interface ForecastMinute {
  at: number;
  demand: number;
}

export interface CapacityAccount {
  id: string;
  models: string[];
  accountRpm: number;
  egressId: string;
  egressRpm: number | null;
  modelConcurrency: Record<string, number>;
  healthy: boolean;
}

export interface ModelForecastInput {
  model: string;
  minutes: ForecastMinute[];
  durationsMs: number[];
  amplifications: number[];
  accounts: CapacityAccount[];
  now: number;
  safetyMargin?: number;
}

export function percentile(values: number[], quantile: number): number {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

export function ewma(values: number[], alpha: number): number {
  if (values.length === 0) return 0;
  let result = values[0]!;
  for (const value of values.slice(1)) result = alpha * value + (1 - alpha) * result;
  return result;
}

export function denseMinutes(minutes: ForecastMinute[], now: number, maximum = 60): ForecastMinute[] {
  if (minutes.length === 0) return [];
  const byMinute = new Map(minutes.map((minute) => [Math.floor(minute.at / 60_000) * 60_000, minute.demand]));
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  const earliestMinute = Math.min(...byMinute.keys());
  const observedCount = Math.max(1, Math.floor((currentMinute - earliestMinute) / 60_000) + 1);
  const count = Math.min(maximum, observedCount);
  return Array.from({ length: count }, (_, index) => {
    const at = currentMinute - (count - 1 - index) * 60_000;
    return { at, demand: byMinute.get(at) ?? 0 };
  });
}

function windowValues(minutes: ForecastMinute[], now: number, count: number): number[] {
  const cutoff = now - count * 60_000;
  return minutes.filter((minute) => minute.at > cutoff && minute.at <= now).map((minute) => minute.demand);
}

export function forecastDemand(minutes: ForecastMinute[], now: number, safetyMargin = 0.2): {
  rpm: number;
  rawRpm: number;
  trend15m: number;
  sampleMinutes: number;
} {
  const dense = denseMinutes(minutes, now, 60);
  const values5 = windowValues(dense, now, 5);
  const values15 = windowValues(dense, now, 15);
  const values60 = windowValues(dense, now, 60);
  const short = ewma(values5, 0.55);
  const medium = ewma(values15, 0.25);
  const long = ewma(values60, 0.08);
  const trend = medium > 0 ? (short - medium) / medium : 0;
  const boundedTrend = Math.max(-0.25, Math.min(0.5, trend));
  const baseline = Math.max(medium, long * 0.75);
  const rawRpm = Math.max(short, baseline * (1 + Math.max(0, boundedTrend)));
  return {
    rpm: rawRpm * (1 + safetyMargin),
    rawRpm,
    trend15m: boundedTrend,
    sampleMinutes: values60.length,
  };
}

export function concurrencyRpm(concurrency: number, p95DurationMs: number): number {
  return concurrency * 60_000 / Math.max(1_000, p95DurationMs || 30_000);
}

function modelCapacity(account: CapacityAccount, model: string, p95DurationMs: number, amplification: number): number {
  const concurrency = account.modelConcurrency[model] ?? 0;
  const upstreamCapacity = Math.min(account.accountRpm, concurrencyRpm(concurrency, p95DurationMs));
  return upstreamCapacity / Math.max(1, amplification);
}

function effectiveCapacity(
  accounts: CapacityAccount[],
  model: string,
  p95DurationMs: number,
  amplification: number,
): { capacity: number; constraint: ForecastConstraint; accountTemplateCapacity: number } {
  const capable = accounts.filter((account) => account.healthy && account.models.includes(model));
  if (capable.length === 0) return { capacity: 0, constraint: "no_healthy_account", accountTemplateCapacity: 0 };
  let capacity = 0;
  let accountLimited = 0;
  let concurrencyLimited = 0;
  const byEgress = new Map<string, { capacity: number; limit: number | null }>();
  for (const account of capable) {
    const concurrencyCapacity = concurrencyRpm(account.modelConcurrency[model] ?? 0, p95DurationMs);
    const upstream = Math.min(account.accountRpm, concurrencyCapacity);
    if (account.accountRpm <= concurrencyCapacity) accountLimited += 1;
    else concurrencyLimited += 1;
    const group = byEgress.get(account.egressId) ?? { capacity: 0, limit: account.egressRpm };
    group.capacity += upstream;
    byEgress.set(account.egressId, group);
  }
  let egressLimited = false;
  for (const group of byEgress.values()) {
    const upstream = group.limit === null ? group.capacity : Math.min(group.capacity, group.limit);
    if (group.limit !== null && group.limit < group.capacity) egressLimited = true;
    capacity += upstream / Math.max(1, amplification);
  }
  const capacities = capable.map((account) => modelCapacity(account, model, p95DurationMs, amplification)).filter((value) => value > 0);
  const accountTemplateCapacity = percentile(capacities, 0.5);
  const constraint: ForecastConstraint = egressLimited
    ? "shared_egress_rpm"
    : concurrencyLimited > accountLimited
      ? "model_concurrency"
      : "account_rpm";
  return { capacity, constraint, accountTemplateCapacity };
}

export interface RecommendationHistoryEntry {
  recommendedAccounts: number;
  targetModel?: string;
}

export function stabilizeCapacityRecommendation(
  item: CapacityRecommendation,
  history: RecommendationHistoryEntry[],
): CapacityRecommendation {
  if (item.bindingConstraint === "shared_egress_rpm"
    || item.bindingConstraint === "no_healthy_account"
    || item.bindingConstraint === "insufficient_samples") {
    return item;
  }
  const previous = history.slice(0, 2);
  if (item.recommendedAccounts > 0) {
    const sustained = previous.length === 2 && previous.every((entry) => entry.recommendedAccounts > 0);
    return sustained ? item : { ...item, recommendedAccounts: 0, stabilizing: true };
  }
  const previousActive = previous.find((entry) => entry.recommendedAccounts > 0);
  if (previousActive) {
    return {
      ...item,
      ...(previousActive.targetModel ? { model: previousActive.targetModel } : {}),
      recommendedAccounts: previousActive.recommendedAccounts,
      stabilizing: true,
    };
  }
  return item;
}

export interface PortfolioForecast {
  recommendations: CapacityRecommendation[];
  topRecommendation?: CapacityRecommendation;
  totalRecommendedAccounts: number;
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  flow: number;
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: number): FlowEdge {
  const forward: FlowEdge = { to, reverse: graph[to]!.length, capacity, flow: 0 };
  const reverse: FlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0, flow: 0 };
  graph[from]!.push(forward);
  graph[to]!.push(reverse);
  return forward;
}

function maxFlow(graph: FlowEdge[][], source: number, sink: number): number {
  let total = 0;
  while (true) {
    const parent = Array.from({ length: graph.length }, () => ({ node: -1, edge: -1 }));
    const queue = [source];
    parent[source] = { node: source, edge: -1 };
    for (let cursor = 0; cursor < queue.length && parent[sink]!.node < 0; cursor += 1) {
      const node = queue[cursor]!;
      for (let index = 0; index < graph[node]!.length; index += 1) {
        const edge = graph[node]![index]!;
        if (parent[edge.to]!.node >= 0 || edge.capacity - edge.flow <= 1e-9) continue;
        parent[edge.to] = { node, edge: index };
        queue.push(edge.to);
        if (edge.to === sink) break;
      }
    }
    if (parent[sink]!.node < 0) return total;
    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source;) {
      const step = parent[node]!;
      const edge = graph[step.node]![step.edge]!;
      amount = Math.min(amount, edge.capacity - edge.flow);
      node = step.node;
    }
    for (let node = sink; node !== source;) {
      const step = parent[node]!;
      const edge = graph[step.node]![step.edge]!;
      edge.flow += amount;
      graph[node]![edge.reverse]!.flow -= amount;
      node = step.node;
    }
    total += amount;
  }
}

/**
 * Allocate all model demand through account RPM and egress RPM exactly once.
 * This prevents two model forecasts from each claiming the same shared slot.
 */
interface PortfolioAllocation {
  totalDemand: number;
  totalFlow: number;
  modelFlow: Map<string, number>;
  modelAccountFlow: Map<string, Map<string, number>>;
  saturatedEgresses: Set<string>;
}

function allocatePortfolio(inputs: ModelForecastInput[], accounts: CapacityAccount[]): PortfolioAllocation {
  const eligibleByModel = new Map(inputs.map((input) => [
    input.model,
    new Set(input.accounts.filter((account) => account.healthy && account.models.includes(input.model)).map((account) => account.id)),
  ]));
  // Explicit candidate accounts passed by the caller are healthy templates.
  for (const input of inputs) {
    const eligible = eligibleByModel.get(input.model)!;
    for (const account of accounts) {
      if (account.healthy && account.models.includes(input.model)) eligible.add(account.id);
    }
  }
  const source = 0;
  const modelOffset = 1;
  const accountOffset = modelOffset + inputs.length;
  const egressIds = [...new Set(accounts.map((account) => account.egressId))];
  const egressOffset = accountOffset + accounts.length;
  const sink = egressOffset + egressIds.length;
  const graph = Array.from({ length: sink + 1 }, () => [] as FlowEdge[]);
  const modelEdges = new Map<string, FlowEdge>();
  const modelAccountEdges = new Map<string, Map<string, FlowEdge>>();
  const egressEdges = new Map<string, FlowEdge>();
  let totalDemand = 0;

  inputs.forEach((input, modelIndex) => {
    const demand = forecastDemand(input.minutes, input.now, input.safetyMargin ?? 0.2);
    const p95 = percentile(input.durationsMs, 0.95) || 30_000;
    const amplification = Math.max(1, percentile(input.amplifications, 0.95) || 1);
    const upstreamDemand = demand.rpm * amplification;
    totalDemand += upstreamDemand;
    modelEdges.set(input.model, addFlowEdge(graph, source, modelOffset + modelIndex, upstreamDemand));
    const accountEdges = new Map<string, FlowEdge>();
    accounts.forEach((account, accountIndex) => {
      if (!eligibleByModel.get(input.model)?.has(account.id)) return;
      const edge = addFlowEdge(
        graph,
        modelOffset + modelIndex,
        accountOffset + accountIndex,
        concurrencyRpm(account.modelConcurrency[input.model] ?? 0, p95),
      );
      accountEdges.set(account.id, edge);
    });
    modelAccountEdges.set(input.model, accountEdges);
  });

  accounts.forEach((account, accountIndex) => {
    const egressIndex = egressIds.indexOf(account.egressId);
    addFlowEdge(graph, accountOffset + accountIndex, egressOffset + egressIndex, account.accountRpm);
  });
  egressIds.forEach((egressId, index) => {
    const members = accounts.filter((account) => account.egressId === egressId);
    const configured = members.map((account) => account.egressRpm).find((value): value is number => value !== null);
    egressEdges.set(egressId, addFlowEdge(graph, egressOffset + index, sink, configured ?? Number.MAX_SAFE_INTEGER));
  });
  const totalFlow = maxFlow(graph, source, sink);
  const modelFlow = new Map([...modelEdges].map(([model, edge]) => [model, edge.flow]));
  const modelAccountFlow = new Map([...modelAccountEdges].map(([model, edges]) => [
    model,
    new Map([...edges].map(([accountId, edge]) => [accountId, edge.flow])),
  ]));
  const saturatedEgresses = new Set([...egressEdges]
    .filter(([, edge]) => edge.capacity < Number.MAX_SAFE_INTEGER && edge.flow >= edge.capacity - 1e-9)
    .map(([egressId]) => egressId));
  return { totalDemand, totalFlow, modelFlow, modelAccountFlow, saturatedEgresses };
}

function accountTemplateKey(account: CapacityAccount): string {
  return JSON.stringify({
    models: [...account.models].sort(),
    accountRpm: account.accountRpm,
    modelConcurrency: Object.fromEntries(Object.entries(account.modelConcurrency).sort(([left], [right]) => left.localeCompare(right))),
  });
}

/**
 * Allocate all model demand through account RPM and egress RPM exactly once.
 * Additional-account counts are returned only after added account templates
 * make the complete safety-adjusted demand feasible in the same flow graph.
 */
export function recommendCapacityPortfolio(inputs: ModelForecastInput[]): PortfolioForecast {
  if (inputs.length === 0) return { recommendations: [], totalRecommendedAccounts: 0 };
  const accounts = [...new Map(inputs.flatMap((input) => input.accounts).map((account) => [account.id, account])).values()];
  const current = allocatePortfolio(inputs, accounts);
  const independent = inputs.map((input) => recommendCapacity(input));
  const demandByModel = new Map(inputs.map((input) => {
    const demand = forecastDemand(input.minutes, input.now, input.safetyMargin ?? 0.2);
    const amplification = Math.max(1, percentile(input.amplifications, 0.95) || 1);
    return [input.model, { demand, amplification }];
  }));
  const rawRecommendations = independent.map((base) => {
    const demand = demandByModel.get(base.model)!;
    const effectiveCapacityRpm = (current.modelFlow.get(base.model) ?? 0) / demand.amplification;
    const deficit = Math.max(0, demand.demand.rpm - effectiveCapacityRpm);
    const capable = accounts.filter((account) => account.healthy && account.models.includes(base.model));
    const sharedEgressLimited = capable.some((account) => current.saturatedEgresses.has(account.egressId));
    const bindingConstraint: ForecastConstraint = base.confidence === "low"
      ? "insufficient_samples"
      : sharedEgressLimited && deficit > 0
        ? "shared_egress_rpm"
        : base.bindingConstraint;
    return {
      ...base,
      effectiveCapacityRpm,
      utilization: effectiveCapacityRpm > 0 ? demand.demand.rawRpm / effectiveCapacityRpm : demand.demand.rawRpm > 0 ? 1 : 0,
      recommendedAccounts: 0,
      bindingConstraint,
    };
  });

  const accountDeficitExists = rawRecommendations.some((item) =>
    item.confidence !== "low"
    && item.bindingConstraint !== "shared_egress_rpm"
    && (current.modelFlow.get(item.model) ?? 0) < demandByModel.get(item.model)!.demand.rpm * demandByModel.get(item.model)!.amplification - 1e-9);
  const templates = [...new Map(accounts.map((account) => [accountTemplateKey(account), account])).values()];
  const selected: CapacityAccount[] = [];
  let allocation = current;
  const maxAddedAccounts = 1_000;
  for (let sequence = 0; accountDeficitExists && allocation.totalFlow < allocation.totalDemand - 1e-9 && sequence < maxAddedAccounts; sequence += 1) {
    let best: { account: CapacityAccount; allocation: PortfolioAllocation } | undefined;
    for (const template of templates) {
      const candidate: CapacityAccount = {
        ...template,
        id: `forecast-template-${sequence}-${template.id}`,
        healthy: true,
        // Account expansion is useful only with independent egress capacity.
        egressId: `forecast-egress-${sequence}-${template.id}`,
        egressRpm: null,
      };
      const candidateAllocation = allocatePortfolio(inputs, [...accounts, ...selected, candidate]);
      if (!best || candidateAllocation.totalFlow > best.allocation.totalFlow + 1e-9) {
        best = { account: candidate, allocation: candidateAllocation };
      }
    }
    if (!best || best.allocation.totalFlow <= allocation.totalFlow + 1e-9) break;
    selected.push(best.account);
    allocation = best.allocation;
  }

  if (allocation.totalFlow >= allocation.totalDemand - 1e-9) {
    // Remove any clone that is not required for feasibility.
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      const without = selected.filter((_, candidateIndex) => candidateIndex !== index);
      const candidate = allocatePortfolio(inputs, [...accounts, ...without]);
      if (candidate.totalFlow >= candidate.totalDemand - 1e-9) {
        selected.splice(index, 1);
        allocation = candidate;
      }
    }
  }

  const feasible = allocation.totalFlow >= allocation.totalDemand - 1e-9;
  const recommendations = rawRecommendations.map((item) => {
    const demand = demandByModel.get(item.model)!;
    const hasDeficit = (current.modelFlow.get(item.model) ?? 0) < demand.demand.rpm * demand.amplification - 1e-9;
    if (!feasible && hasDeficit && item.bindingConstraint !== "shared_egress_rpm" && item.confidence !== "low") {
      return { ...item, bindingConstraint: "no_healthy_account" as const };
    }
    if (!feasible || item.confidence === "low" || item.bindingConstraint === "shared_egress_rpm") return item;
    const usedAccounts = selected.filter((account) =>
      (allocation.modelAccountFlow.get(item.model)?.get(account.id) ?? 0) > 1e-9).length;
    return { ...item, recommendedAccounts: usedAccounts };
  });
  const totalRecommendedAccounts = feasible ? selected.length : 0;
  const deficientModels = recommendations.filter((item) => item.recommendedAccounts > 0).map((item) => item.model).sort();
  const ranked = [...recommendations].sort((left, right) =>
    right.recommendedAccounts - left.recommendedAccounts || right.utilization - left.utilization);
  const top = ranked[0];
  const topRecommendation = top && totalRecommendedAccounts > 0
    ? {
        ...top,
        model: deficientModels.join(" + ") || top.model,
        recommendedAccounts: totalRecommendedAccounts,
      }
    : top;
  return {
    recommendations,
    ...(topRecommendation ? { topRecommendation } : {}),
    totalRecommendedAccounts,
  };
}

export function recommendCapacity(input: ModelForecastInput): CapacityRecommendation {
  const safetyMargin = input.safetyMargin ?? 0.2;
  const demand = forecastDemand(input.minutes, input.now, safetyMargin);
  const p95DurationMs = percentile(input.durationsMs, 0.95) || 30_000;
  const amplification = Math.max(1, percentile(input.amplifications, 0.95) || 1);
  const current = effectiveCapacity(input.accounts, input.model, p95DurationMs, amplification);
  const deficit = Math.max(0, demand.rpm - current.capacity);
  const enoughSamples = demand.sampleMinutes >= 15 && input.durationsMs.length >= 20;
  const confidence = demand.sampleMinutes >= 45 && input.durationsMs.length >= 100
    ? "high"
    : enoughSamples ? "medium" : "low";
  const recommendationAllowed = confidence !== "low" && current.constraint !== "shared_egress_rpm";
  const recommendedAccounts = recommendationAllowed && deficit > 0 && current.accountTemplateCapacity > 0
    ? Math.ceil(deficit / current.accountTemplateCapacity)
    : 0;
  const utilization = current.capacity > 0 ? demand.rawRpm / current.capacity : demand.rawRpm > 0 ? 1 : 0;
  const slopePerMinute = demand.trend15m > 0 ? demand.rawRpm * demand.trend15m / 15 : 0;
  const threshold = current.capacity / (1 + safetyMargin);
  const timeToThresholdMinutes = slopePerMinute > 0 && demand.rawRpm < threshold
    ? Math.max(0, Math.ceil((threshold - demand.rawRpm) / slopePerMinute))
    : undefined;
  return {
    model: input.model,
    forecastRpm: demand.rpm,
    effectiveCapacityRpm: current.capacity,
    utilization,
    recommendedAccounts,
    bindingConstraint: confidence === "low" ? "insufficient_samples" : current.constraint,
    confidence,
    sampleMinutes: demand.sampleMinutes,
    p95SampleCount: input.durationsMs.length,
    p95DurationMs,
    p95Amplification: amplification,
    safetyMargin,
    ...(timeToThresholdMinutes !== undefined ? { timeToThresholdMinutes } : {}),
  };
}

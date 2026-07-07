// F3(c) 결정 체인 뷰 — deterministic horizontal lanes, one per supersedes
// chain (oldest → newest, arrows between), isolated decisions on a side rail.

import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { buildDecisionChains } from "../../lib/graph/decisionChains";
import type { GraphModel, GraphNode } from "../../lib/graph/model";
import { useTranslation } from "../../lib/i18n";

interface DecisionChainLanesProps {
  model: GraphModel;
  onNodeClick: (node: GraphNode) => void;
}

function DecisionChip({
  node,
  onNodeClick,
}: {
  node: GraphNode;
  onNodeClick: (node: GraphNode) => void;
}) {
  return (
    <button
      type="button"
      className="decision-chip"
      title={node.relPath ?? node.id}
      onClick={() => onNodeClick(node)}
    >
      <span className="decision-chip-label">{node.label}</span>
      {node.date ? <span className="decision-chip-date">{node.date.slice(0, 10)}</span> : null}
    </button>
  );
}

export function DecisionChainLanes({ model, onNodeClick }: DecisionChainLanesProps) {
  const { t } = useTranslation();
  const layout = useMemo(() => buildDecisionChains(model), [model]);

  return (
    <div className="decision-chains" data-testid="decision-chains">
      <section className="decision-chains-lanes">
        <h4>
          {t("graph.decisions.chains")} ({layout.chains.length})
        </h4>
        {layout.chains.length === 0 ? (
          <p className="decision-chains-empty">{t("graph.decisions.noChains")}</p>
        ) : (
          layout.chains.map((chain) => (
            <div className="decision-lane" key={chain.nodes[0].id} data-testid="decision-lane">
              {chain.nodes.map((node, i) => (
                <span className="decision-lane-step" key={node.id}>
                  {i > 0 ? <ArrowRight size={14} className="decision-lane-arrow" /> : null}
                  <DecisionChip node={node} onNodeClick={onNodeClick} />
                </span>
              ))}
            </div>
          ))
        )}
      </section>
      <aside className="decision-chains-rail">
        <h4>
          {t("graph.decisions.isolated")} ({layout.isolated.length})
        </h4>
        <div className="decision-rail-list">
          {layout.isolated.map((node) => (
            <DecisionChip key={node.id} node={node} onNodeClick={onNodeClick} />
          ))}
        </div>
      </aside>
    </div>
  );
}

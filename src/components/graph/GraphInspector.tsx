// Right-pane inspector for the selected graph node: metadata + typed
// neighbors (outgoing / incoming, click to walk), and node actions
// (open note / focus subgraph / start path).

import { ExternalLink, GitBranch, Route } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "../../lib/i18n";
import type { GraphModel, GraphNode } from "../../lib/graph/model";
import { communityColor, domainColor } from "./GraphCanvas";

interface Neighbor {
  id: string;
  label: string;
  relation: string;
}

interface GraphInspectorProps {
  node: GraphNode | null;
  model: GraphModel;
  onSelectNode: (id: string) => void;
  onOpen: (node: GraphNode) => void;
  onFocus: (node: GraphNode) => void;
  onStartPath: (node: GraphNode) => void;
}

export function GraphInspector({
  node,
  model,
  onSelectNode,
  onOpen,
  onFocus,
  onStartPath,
}: GraphInspectorProps) {
  const { t } = useTranslation();

  const { outgoing, incoming } = useMemo(() => {
    const labels = new Map(model.nodes.map((n) => [n.id, n.label]));
    const out: Neighbor[] = [];
    const inc: Neighbor[] = [];
    if (node) {
      for (const edge of model.edges) {
        if (edge.source === node.id) {
          out.push({ id: edge.target, label: labels.get(edge.target) ?? edge.target, relation: edge.relation });
        } else if (edge.target === node.id) {
          inc.push({ id: edge.source, label: labels.get(edge.source) ?? edge.source, relation: edge.relation });
        }
      }
    }
    return { outgoing: out, incoming: inc };
  }, [node, model]);

  if (!node) {
    return (
      <div className="graph-inspector graph-inspector-empty" data-testid="graph-inspector">
        {t("graph.inspector.empty")}
      </div>
    );
  }

  const isGhost = node.type === "unresolved";

  return (
    <div className="graph-inspector" data-testid="graph-inspector">
      <h3 className="graph-inspector-title">{node.label}</h3>
      <div className="graph-inspector-meta">
        <span className="graph-tag">{node.type}</span>
        {node.domain ? (
          <span className="graph-tag">
            <span className="graph-swatch" style={{ background: domainColor(node.domain) }} />
            {node.domain}
          </span>
        ) : null}
        {node.community != null ? (
          <span className="graph-tag">
            <span className="graph-swatch" style={{ background: communityColor(node.community) }} />
            #{node.community}
          </span>
        ) : null}
        <span className="graph-tag graph-tag-degree">{t("graph.inspector.degree")}: {node.degree}</span>
      </div>
      {node.updatedAt ? (
        <div className="graph-inspector-date">{node.updatedAt.slice(0, 10)}</div>
      ) : null}

      <div className="graph-inspector-actions">
        {!isGhost ? (
          <button type="button" className="graph-action" onClick={() => onOpen(node)}>
            <ExternalLink size={13} /> {t("graph.inspector.open")}
          </button>
        ) : null}
        <button type="button" className="graph-action" onClick={() => onFocus(node)}>
          <GitBranch size={13} /> {t("graph.inspector.focus")}
        </button>
        <button type="button" className="graph-action" onClick={() => onStartPath(node)}>
          <Route size={13} /> {t("graph.inspector.startPath")}
        </button>
      </div>

      {outgoing.length > 0 ? (
        <NeighborList
          title={`${t("graph.inspector.outgoing")} (${outgoing.length})`}
          neighbors={outgoing}
          onSelectNode={onSelectNode}
        />
      ) : null}
      {incoming.length > 0 ? (
        <NeighborList
          title={`${t("graph.inspector.incoming")} (${incoming.length})`}
          neighbors={incoming}
          onSelectNode={onSelectNode}
        />
      ) : null}
      {outgoing.length === 0 && incoming.length === 0 ? (
        <p className="graph-inspector-note">{t("graph.inspector.noLinks")}</p>
      ) : null}
    </div>
  );
}

function NeighborList({
  title,
  neighbors,
  onSelectNode,
}: {
  title: string;
  neighbors: Neighbor[];
  onSelectNode: (id: string) => void;
}) {
  return (
    <section className="graph-neighbor-section">
      <h4>{title}</h4>
      <ul className="graph-neighbor-list">
        {neighbors.map((n, i) => (
          <li key={`${n.id}-${i}`}>
            <button type="button" className="graph-neighbor" onClick={() => onSelectNode(n.id)}>
              <span className="graph-neighbor-relation">{n.relation}</span>
              <span className="graph-neighbor-label">{n.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

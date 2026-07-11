import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeftRight, Link2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  graphLinkApply,
  graphLinkPreview,
  type GraphLinkProposal,
  type GraphLinkRequest,
} from "../../lib/api";
import type { GraphNode } from "../../lib/graph/model";
import { useTranslation } from "../../lib/i18n";

const RELATIONS = ["related", "supersedes", "superseded_by"] as const;

export function GraphRelationReviewDialog({
  open,
  source,
  target,
  workspacePath,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  source: GraphNode | null;
  target: GraphNode | null;
  workspacePath: string | null;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [relation, setRelation] = useState<(typeof RELATIONS)[number]>("related");
  const [reciprocal, setReciprocal] = useState(false);
  const [proposal, setProposal] = useState<GraphLinkProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useMemo<GraphLinkRequest | null>(() => {
    if (!source?.relPath || !target?.relPath || !workspacePath) return null;
    return {
      sourceWorkspace: source.ownerWorkspacePath ?? workspacePath,
      sourceDocument: source.relPath,
      targetWorkspace: target.ownerWorkspacePath ?? workspacePath,
      targetDocument: target.relPath,
      relation,
      reciprocal,
    };
  }, [source, target, workspacePath, relation, reciprocal]);

  useEffect(() => {
    if (!open || !request) {
      setProposal(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void graphLinkPreview(request)
      .then((next) => {
        if (!cancelled) setProposal(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, request]);

  const apply = async () => {
    if (!proposal?.changed) return;
    setApplying(true);
    setError(null);
    try {
      await graphLinkApply(proposal);
      onApplied();
      onOpenChange(false);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content graph-relation-dialog" data-testid="graph-relation-dialog">
          <div className="dialog-title-row">
            <Dialog.Title>{t("graph.relation.title")}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t("app.errorClose")}><X size={16} /></Dialog.Close>
          </div>
          <Dialog.Description>{t("graph.relation.description")}</Dialog.Description>
          <div className="graph-relation-pair">
            <strong>{source?.label}</strong><ArrowLeftRight size={14} /><strong>{target?.label}</strong>
          </div>
          <label className="field-label">
            {t("graph.relation.type")}
            <select value={relation} onChange={(event) => setRelation(event.target.value as (typeof RELATIONS)[number])}>
              {RELATIONS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={reciprocal} onChange={(event) => setReciprocal(event.target.checked)} />
            {t("graph.relation.reciprocal")}
          </label>
          <div className="graph-relation-preview" aria-busy={loading}>
            {loading ? <p>…</p> : null}
            {proposal?.patches.map((patch) => (
              <section key={`${patch.workspace}:${patch.document}:${patch.field}`}>
                <strong>{patch.document}</strong>
                <code>{patch.field}: {patch.afterValues.join(", ")}</code>
                <small>{patch.changed ? t("graph.relation.willChange") : t("graph.relation.noop")}</small>
              </section>
            ))}
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <Dialog.Close className="button secondary">{t("dialog.cancel")}</Dialog.Close>
            <button type="button" className="button primary" disabled={loading || applying || !proposal?.changed} onClick={() => void apply()}>
              <Link2 size={14} /> {applying ? t("graph.relation.applying") : t("graph.relation.apply")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

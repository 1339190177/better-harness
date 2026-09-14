import { FileCode } from "@phosphor-icons/react/FileCode";
import { useTranslation } from "react-i18next";
import type { StructuralDiff, StructuralDiffLine, StructuralDiffSide } from "../../contracts/structural-diff.js";

/**
 * The structural reading of one changed file: aligned older/newer lines with
 * only the runs the engine flagged marked on each side.
 *
 * Removed runs borrow the danger role and added runs the success role, which is
 * the polarity Studio's validation surfaces already use. Inventing a diff-only
 * colour for the same meaning is exactly the token drift DESIGN.md forbids.
 */
export function StructuralDiffView(props: { diff: StructuralDiff; label: string }): React.JSX.Element {
  const { t } = useTranslation("git");
  const changed = props.diff.lines.filter(isChanged).length;
  return <div
    className="structural-diff"
    data-structural-diff="ready"
    data-diff-status={props.diff.status}
    data-language={props.diff.language}
    aria-label={props.label}
  >
    <header className="structural-diff-summary">
      <strong>{props.diff.language}</strong>
      <span>{t("structural.summary", { changed, total: props.diff.lines.length })}</span>
    </header>
    {props.diff.lines.length === 0
      ? <div className="git-diff-empty"><FileCode aria-hidden="true" size={22} /><p>{t("structural.noChanges")}</p></div>
      : <div className="structural-diff-rows">
        {props.diff.lines.map((line, index) => <Row key={`${index}:${line.lhs?.lineNumber ?? ""}:${line.rhs?.lineNumber ?? ""}`} line={line} index={index} />)}
      </div>}
  </div>;
}

function Row(props: { line: StructuralDiffLine; index: number }): React.JSX.Element {
  return <div className="structural-diff-row" data-line={props.index} data-changed={isChanged(props.line)}>
    <Side side={props.line.lhs} revision="lhs" />
    <Side side={props.line.rhs} revision="rhs" />
  </div>;
}

/**
 * Both sides always occupy a column, even when a line exists on only one of
 * them, so the two revisions stay aligned.
 */
function Side(props: { side: StructuralDiffSide | null; revision: "lhs" | "rhs" }): React.JSX.Element {
  if (props.side === null) return <div className="structural-diff-side" data-side={props.revision} data-absent="true" aria-hidden="true" />;
  return <div className="structural-diff-side" data-side={props.revision} data-line-number={props.side.lineNumber}>
    <span className="structural-diff-number" aria-hidden="true">{props.side.lineNumber}</span>
    <code className="structural-diff-code">{props.side.segments.length === 0
      ? "\u00a0"
      : props.side.segments.map((segment, index) => <span
        key={index}
        className={segment.novel ? "structural-diff-run" : undefined}
        data-novel={segment.novel}
        data-highlight={segment.highlight}
      >{segment.text}</span>)}</code>
  </div>;
}

function isChanged(line: StructuralDiffLine): boolean {
  return changed(line.lhs) || changed(line.rhs);
}

function changed(side: StructuralDiffSide | null): boolean {
  return side !== null && side.segments.some((segment) => segment.novel);
}

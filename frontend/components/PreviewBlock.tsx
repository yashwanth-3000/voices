type PreviewBlockProps = {
  title: string;
  content: string;
  toneLabel?: string;
};

export function PreviewBlock({ title, content, toneLabel }: PreviewBlockProps) {
  return (
    <div className="preview">
      <div className="previewHeader">
        <div className="row" style={{ gap: 10 }}>
          <div className="lights" aria-hidden="true">
            <span className="light l1" />
            <span className="light l2" />
            <span className="light l3" />
          </div>
          <div className="previewTitle">
            {title}
            {toneLabel ? <span className="muted"> · {toneLabel}</span> : null}
          </div>
        </div>
        <span className="badge">Generated preview</span>
      </div>
      <div className="previewBody mono">{content}</div>
    </div>
  );
}


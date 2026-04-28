type CreatorCardProps = {
  name: string;
  handle: string;
  style: string;
  description: string;
  pricePerUse: string;
  tags: string[];
};

export function CreatorCard({
  name,
  handle,
  style,
  description,
  pricePerUse,
  tags,
}: CreatorCardProps) {
  return (
    <div className="creatorCard">
      <div className="creatorTop">
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          <div className="avatar" aria-hidden="true" />
          <div>
            <h3 className="creatorName">{name}</h3>
            <div className="creatorMeta">
              @{handle} · <span className="muted">{style}</span>
            </div>
          </div>
        </div>
        <div className="price">{pricePerUse}</div>
      </div>

      <p className="creatorDesc">{description}</p>

      <div className="chips" aria-label="Style tags">
        {tags.map((t) => (
          <span className="chip" key={t}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}


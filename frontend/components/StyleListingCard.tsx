type StyleListingCardProps = {
  title: string;
  creator: string;
  price: string;
  tags: string[];
  blurb: string;
};

export function StyleListingCard({
  title,
  creator,
  price,
  tags,
  blurb,
}: StyleListingCardProps) {
  return (
    <div className="styleListing">
      <div className="styleListingTop">
        <div>
          <div className="styleListingTitle">{title}</div>
          <div className="styleListingMeta">{creator}</div>
        </div>
        <div className="styleListingPrice">{price}</div>
      </div>
      <div className="styleListingBlurb">“{blurb}”</div>
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


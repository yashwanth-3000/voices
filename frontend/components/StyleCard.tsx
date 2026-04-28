type StyleCardProps = {
  name: string;
  badge: string;
  description: string;
};

export function StyleCard({ name, badge, description }: StyleCardProps) {
  return (
    <div className="styleCard">
      <div className="styleTop">
        <div className="styleName">{name}</div>
        <span className="badge">{badge}</span>
      </div>
      <div className="styleDesc">{description}</div>
    </div>
  );
}


import { Icon } from "./Icon";

export function PageHeader({
  eyebrow,
  title,
  sub,
  icon,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  icon?: string;
}) {
  return (
    <div className="page-head">
      <p className="page-eyebrow">{eyebrow}</p>
      <h1 className="page-title">
        {icon && (
          <Icon
            name={icon}
            size={24}
            strokeWidth={1.6}
            style={{ verticalAlign: "-4px", marginRight: 10, color: "var(--gold)" }}
          />
        )}
        {title}
      </h1>
      {sub && <p className="page-sub">{sub}</p>}
    </div>
  );
}

export function DemoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="demo-note" role="note">
      <Icon name="alert" size={16} />
      <span>{children}</span>
    </div>
  );
}

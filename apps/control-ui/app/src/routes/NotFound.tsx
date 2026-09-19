import { Link } from "../router";
import { EmptyState, PageHead } from "../components/ui";

export function NotFound() {
  return (
    <div className="page" data-testid="page-not-found">
      <PageHead title="Page not found" />
      <EmptyState title="That address does not match a Mission Control view.">
        <Link to="/overview">Go to Overview</Link>
      </EmptyState>
    </div>
  );
}

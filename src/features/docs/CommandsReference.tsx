/**
 * The command reference on the documentation page.
 *
 * It is generated from `command-catalog.ts` — the same list the palette and the
 * shortcut listener use — so a command cannot exist without being documented,
 * and its documented chord is the chord that actually runs it.
 */
import {
  COMMAND_CATALOG,
  COMMAND_CATEGORIES,
} from "../commands/command-catalog";
import { bindingLabel } from "../commands/shortcuts";

export default function CommandsReference() {
  return (
    <div className="ref" data-testid="commands-reference">
      <p className="ref__intro">
        Every action the editor offers, with the chord that runs it. The same
        list backs the command palette (<kbd>⌘/Ctrl</kbd> + <kbd>Shift</kbd> +{" "}
        <kbd>P</kbd>), so the shortcut printed here is the one that runs the
        command.
      </p>

      {COMMAND_CATEGORIES.map((category) => {
        const specs = COMMAND_CATALOG.filter(
          (spec) => spec.category === category,
        );
        if (specs.length === 0) return null;
        return (
          <section
            className="ref__group"
            key={category}
            data-testid={`commands-group-${category.toLowerCase()}`}
          >
            <h3 className="ref__group-title">{category}</h3>
            <dl className="ref__list">
              {specs.map((spec) => (
                <div className="ref__entry" key={spec.id}>
                  <dt className="ref__name" data-testid={`command-${spec.id}`}>
                    <span className="ref__name-text">{spec.label}</span>
                    <kbd className="ref__shortcut">
                      {bindingLabel(spec.binding)}
                    </kbd>
                  </dt>
                  <dd className="ref__body">
                    <p className="ref__summary">{spec.description}</p>
                    {spec.condition ? (
                      <p className="ref__condition">{spec.condition}</p>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

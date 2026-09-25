/**
 * Parser for the event-flow DSL.
 *
 * The language is small enough to read in one screen:
 *
 * ```
 * title Order Processing
 *
 * event OrderCreated
 * event OrderCreated {
 *   version: 2
 *   domain: Orders
 * }
 *
 * broker Kafka
 * topic orders on Kafka
 * queue billing
 *
 * producer OrderService
 * consumer BillingService
 *
 * OrderService publishes OrderCreated to orders
 * BillingService consumes OrderCreated from orders
 * ```
 *
 * Two spellings of the edge statements are accepted. The subject-first form
 * (`OrderService publishes OrderCreated`) reads like a sentence about a service;
 * the verb-first form (`publish OrderCreated from OrderService`) reads like a
 * sentence about an event. Both produce the same {@link EventPublication} /
 * {@link EventSubscription}, so nothing downstream has to know which was used.
 *
 * A document always parses into an AST — malformed lines become diagnostics and
 * are skipped — because the documentation is valid to read even while it is
 * being written (see ADR-003).
 */
import type {
  BrokerDeclaration,
  ChannelDeclaration,
  ChannelKind,
  EventDeclaration,
  EventFlow,
  EventFlowStatement,
  EventFlowTitle,
  EventFlowHandler,
  EventProvenance,
  HandlerEffect,
  HandlerInput,
  HandlerOutput,
  EventMetadataEntry,
  EventPublication,
  EventSubscription,
  ServiceDeclaration,
  ServiceRole,
  SourceRange,
} from "../../domain/eventflow/ast";
import { validateEventFlowCausality } from "../../domain/eventflow/causality";
import { tokenizeEventFlow, type EventFlowLine } from "./lexer";

/** Stable, machine-readable event-flow diagnostic identifiers. */
export enum EventFlowDiagnosticCode {
  /** A line did not match any construct the language supports. */
  UnsupportedSyntax = "eventflow.unsupported-syntax",
  /** A declaration is missing its name or has trailing text. */
  MalformedDeclaration = "eventflow.malformed-declaration",
  /** A metadata line is not `key: value`. */
  MalformedMetadata = "eventflow.malformed-metadata",
  /** A metadata block was opened but never closed. */
  UnclosedMetadata = "eventflow.unclosed-metadata",
  /** The same event was declared twice. */
  DuplicateEvent = "eventflow.duplicate-event",
  /** The same service was declared twice. */
  DuplicateService = "eventflow.duplicate-service",
  /** The same channel was declared twice. */
  DuplicateChannel = "eventflow.duplicate-channel",
  /** The same broker was declared twice. */
  DuplicateBroker = "eventflow.duplicate-broker",
  /** A metadata key was repeated inside one event's block. */
  DuplicateMetadataKey = "eventflow.duplicate-metadata-key",
  /** A quoted description was not closed. */
  MalformedDescription = "eventflow.malformed-description",
  /** More than one `title` line. */
  DuplicateTitle = "eventflow.duplicate-title",
  /** A `publishes` line names a service that was never declared. */
  UnknownService = "eventflow.unknown-service",
  /** A `publishes` line names an event that was never declared. */
  UnknownEvent = "eventflow.unknown-event",
  /** A publish/consume line names a channel that was never declared. */
  UnknownChannel = "eventflow.unknown-channel",
  /** A channel names a broker that was never declared. */
  UnknownBroker = "eventflow.unknown-broker",
  /** An event is declared but nothing publishes it. */
  EventWithoutProducer = "eventflow.event-without-producer",
  /** An event is published but nothing consumes it. */
  EventWithoutConsumer = "eventflow.event-without-consumer",
  /** A channel is declared but no edge uses it. */
  ChannelWithoutConsumer = "eventflow.channel-without-consumer",
  /** A service is declared but neither publishes nor consumes. */
  UnusedService = "eventflow.unused-service",
  DuplicateHandler = "eventflow.duplicate-handler",
  DuplicateEffect = "eventflow.duplicate-effect",
  DuplicateCausalInput = "eventflow.duplicate-causal-input",
  DuplicateCausalOutput = "eventflow.duplicate-causal-output",
  UnknownHandler = "eventflow.unknown-handler",
  CausalUnknownEvent = "eventflow.causal-unknown-event",
  EffectWithoutHandler = "eventflow.effect-without-handler",
  InvalidProvenance = "eventflow.invalid-provenance",
  MalformedCausalRelationship = "eventflow.malformed-causal-relationship",
}

/** How serious an event-flow diagnostic is. */
export type EventFlowSeverity = "error" | "warning" | "info";

/** A problem found in an event-flow document. */
export interface EventFlowDiagnostic {
  severity: EventFlowSeverity;
  message: string;
  code: EventFlowDiagnosticCode;
  /** Present when the problem is tied to a span. */
  range?: SourceRange;
}

/** The outcome of parsing an event-flow document. */
export interface EventFlowParseResult {
  /** The parsed document. Never `null`: a partial document is still useful. */
  flow: EventFlow;
  diagnostics: EventFlowDiagnostic[];
}

/** Create a syntax diagnostic spanned by a whole line. */
function lineDiagnostic(
  line: EventFlowLine,
  message: string,
  code: EventFlowDiagnosticCode,
): EventFlowDiagnostic {
  const last = line.tokens[line.tokens.length - 1];
  const end = last
    ? last.range.end
    : { line: line.line, column: line.text.length };
  return {
    severity: "error",
    message,
    code,
    range: { start: { line: line.line, column: 0 }, end },
  };
}

/** The span from the first token to the last, or a zero-width point. */
function lineRange(line: EventFlowLine): SourceRange {
  const first = line.tokens[0];
  const last = line.tokens[line.tokens.length - 1];
  if (!first || !last) {
    return {
      start: { line: line.line, column: 0 },
      end: { line: line.line, column: line.text.length },
    };
  }
  return { start: first.range.start, end: last.range.end };
}

/** The names, in source order, of every event a document declares. */
function declaredEvents(statements: EventFlowStatement[]): Set<string> {
  return new Set(
    statements
      .filter(
        (statement): statement is EventDeclaration =>
          statement.type === "event",
      )
      .map((statement) => statement.name),
  );
}

/** The names of every service a document declares. */
function declaredServices(statements: EventFlowStatement[]): Set<string> {
  return new Set(
    statements
      .filter(
        (statement): statement is ServiceDeclaration =>
          statement.type === "service",
      )
      .map((statement) => statement.name),
  );
}

/** The names of every channel a document declares. */
function declaredChannels(statements: EventFlowStatement[]): Set<string> {
  return new Set(
    statements
      .filter(
        (statement): statement is ChannelDeclaration =>
          statement.type === "channel",
      )
      .map((statement) => statement.name),
  );
}

/** The names of every broker a document declares. */
function declaredBrokers(statements: EventFlowStatement[]): Set<string> {
  return new Set(
    statements
      .filter(
        (statement): statement is BrokerDeclaration =>
          statement.type === "broker",
      )
      .map((statement) => statement.name),
  );
}

/** The role keyword a service declaration used. */
const SERVICE_ROLES: Record<string, ServiceRole> = {
  producer: "producer",
  consumer: "consumer",
  service: "service",
};

/** The channel keyword a channel declaration used. */
const CHANNEL_KINDS: Record<string, ChannelKind> = {
  topic: "topic",
  queue: "queue",
  stream: "stream",
};

const PROVENANCES = new Set<EventProvenance>([
  "external",
  "internal",
  "unknown",
]);

/**
 * Parse an event-flow document.
 *
 * Malformed lines are reported and skipped rather than aborting the parse, so
 * the outline and the diagram keep working on a document that is mid-edit.
 */
export function parseEventFlow(source: string): EventFlowParseResult {
  const lines = tokenizeEventFlow(source);
  const statements: EventFlowStatement[] = [];
  const diagnostics: EventFlowDiagnostic[] = [];
  const seenEvents = new Set<string>();
  const seenServices = new Set<string>();
  const seenChannels = new Set<string>();
  const seenBrokers = new Set<string>();
  const handlers: EventFlowHandler[] = [];
  const inputs: HandlerInput[] = [];
  const outputs: HandlerOutput[] = [];
  const effects: HandlerEffect[] = [];
  let title: EventFlowTitle | undefined;

  /** The event whose metadata block is open, if any. */
  let metadataTarget:
    EventDeclaration | EventFlowHandler | HandlerEffect | null = null;
  let metadataKeys = new Set<string>();

  const closeMetadata = (): void => {
    metadataTarget = null;
    metadataKeys = new Set<string>();
  };

  for (const line of lines) {
    const tokens = line.tokens;
    if (tokens.length === 0) continue;
    const first = tokens[0];

    // Inside `event X { … }` every line is `key: value` or the closing brace.
    if (metadataTarget) {
      const target = metadataTarget;
      if (first.type === "braceClose") {
        target.range = { start: target.range!.start, end: first.range.end };
        closeMetadata();
        continue;
      }
      if (tokens.length >= 3 && tokens[1].type === "colon") {
        const key = first.value;
        const value = line.text.slice(tokens[2].range.start.column).trim();
        const normalizedDescription =
          key.toLowerCase() === "description"
            ? parseDescription(value)
            : { value, valid: true };
        if (!normalizedDescription.valid) {
          diagnostics.push({
            severity: "error",
            message:
              "A quoted event description must end with its opening quote",
            code: EventFlowDiagnosticCode.MalformedDescription,
            range: lineRange(line),
          });
        }
        if (metadataKeys.has(key.toLowerCase())) {
          diagnostics.push({
            severity: "warning",
            message: `"${"name" in metadataTarget ? metadataTarget.name : metadataTarget.id}" sets "${key}" more than once`,
            code: EventFlowDiagnosticCode.DuplicateMetadataKey,
            range: lineRange(line),
          });
        }
        const entry: EventMetadataEntry = {
          key,
          value,
          range: lineRange(line),
        };
        target.metadata.push(entry);
        if (
          key.toLowerCase() === "description" &&
          !metadataKeys.has("description") &&
          normalizedDescription.valid &&
          normalizedDescription.value !== ""
        ) {
          target.description = normalizedDescription.value;
        }
        if (target.type === "event" && key.toLowerCase() === "provenance") {
          if (!PROVENANCES.has(value as EventProvenance)) {
            diagnostics.push({
              severity: "error",
              message: `Invalid event provenance "${value}"; use external, internal, or unknown`,
              code: EventFlowDiagnosticCode.InvalidProvenance,
              range: entry.range,
            });
          } else if (!metadataKeys.has("provenance")) {
            target.provenance = value as EventProvenance;
          }
        }
        if (target.type === "effect" && key.toLowerCase() === "kind") {
          target.kind = value;
        }
        metadataKeys.add(key.toLowerCase());
        target.range = {
          start: metadataTarget.range!.start,
          end: entry.range.end,
        };
        continue;
      }
      diagnostics.push(
        lineDiagnostic(
          line,
          "Inside a metadata block each line is `key: value`, or `}` to close it",
          EventFlowDiagnosticCode.MalformedMetadata,
        ),
      );
      continue;
    }

    const keyword = first.value.toLowerCase();

    if (keyword === "title") {
      if (tokens.length < 2) {
        diagnostics.push(
          lineDiagnostic(
            line,
            "`title` needs a value",
            EventFlowDiagnosticCode.MalformedDeclaration,
          ),
        );
        continue;
      }
      if (title) {
        diagnostics.push(
          lineDiagnostic(
            line,
            "Only the first `title` is used",
            EventFlowDiagnosticCode.DuplicateTitle,
          ),
        );
        continue;
      }
      title = {
        value: line.text.slice(tokens[1].range.start.column).trim(),
        range: lineRange(line),
      };
      continue;
    }

    if (
      keyword === "event" ||
      keyword === "broker" ||
      keyword === "producer" ||
      keyword === "consumer" ||
      keyword === "service" ||
      CHANNEL_KINDS[keyword] !== undefined
    ) {
      const name = tokens[1];
      if (!name || name.type !== "word") {
        diagnostics.push(
          lineDiagnostic(
            line,
            `\`${first.value}\` needs a name`,
            EventFlowDiagnosticCode.MalformedDeclaration,
          ),
        );
        continue;
      }
      // `producer A B` is almost certainly a typo; say so rather than guessing.
      const trailing = tokens[2];
      const opensMetadata = trailing?.type === "braceOpen";
      const allowsTail =
        CHANNEL_KINDS[keyword] !== undefined &&
        trailing?.value.toLowerCase() === "on";
      if (trailing && !opensMetadata && !allowsTail) {
        diagnostics.push(
          lineDiagnostic(
            line,
            `Unexpected "${trailing.value}" after \`${first.value} ${name.value}\``,
            EventFlowDiagnosticCode.MalformedDeclaration,
          ),
        );
      }

      if (keyword === "event") {
        if (seenEvents.has(name.value)) {
          diagnostics.push(
            lineDiagnostic(
              line,
              `Event "${name.value}" is declared more than once`,
              EventFlowDiagnosticCode.DuplicateEvent,
            ),
          );
        }
        seenEvents.add(name.value);
        const declaration: EventDeclaration = {
          type: "event",
          name: name.value,
          metadata: [],
          range: lineRange(line),
        };
        statements.push(declaration);
        if (opensMetadata) {
          metadataTarget = declaration;
          metadataKeys = new Set();
        }
        continue;
      }

      if (keyword === "broker") {
        if (seenBrokers.has(name.value)) {
          diagnostics.push(
            lineDiagnostic(
              line,
              `Broker "${name.value}" is declared more than once`,
              EventFlowDiagnosticCode.DuplicateBroker,
            ),
          );
        }
        seenBrokers.add(name.value);
        statements.push({
          type: "broker",
          name: name.value,
          range: lineRange(line),
        });
        continue;
      }

      if (CHANNEL_KINDS[keyword] !== undefined) {
        if (seenChannels.has(name.value)) {
          diagnostics.push(
            lineDiagnostic(
              line,
              `Channel "${name.value}" is declared more than once`,
              EventFlowDiagnosticCode.DuplicateChannel,
            ),
          );
        }
        seenChannels.add(name.value);
        const declaration: ChannelDeclaration = {
          type: "channel",
          name: name.value,
          channelKind: CHANNEL_KINDS[keyword],
          range: lineRange(line),
        };
        if (allowsTail) {
          const broker = tokens[3];
          if (broker && broker.type === "word")
            declaration.broker = broker.value;
        }
        statements.push(declaration);
        continue;
      }

      if (seenServices.has(name.value)) {
        diagnostics.push(
          lineDiagnostic(
            line,
            `Service "${name.value}" is declared more than once`,
            EventFlowDiagnosticCode.DuplicateService,
          ),
        );
      }
      seenServices.add(name.value);
      statements.push({
        type: "service",
        name: name.value,
        role: SERVICE_ROLES[keyword] ?? "service",
        range: lineRange(line),
      });
      continue;
    }

    const causal = parseCausalLine(line);
    if (causal === "malformed") {
      diagnostics.push(
        lineDiagnostic(
          line,
          "Malformed causal relationship; use `event handled by handler`, `handler causes event`, or `handler effect id on handler: description`",
          EventFlowDiagnosticCode.MalformedCausalRelationship,
        ),
      );
      continue;
    }
    if (causal) {
      if (causal.kind === "handler") {
        handlers.push(causal.value);
        if (causal.opensMetadata) {
          metadataTarget = causal.value;
          metadataKeys = new Set();
        }
      } else if (causal.kind === "input") inputs.push(causal.value);
      else if (causal.kind === "output") outputs.push(causal.value);
      else {
        effects.push(causal.value);
        if (causal.opensMetadata) {
          metadataTarget = causal.value;
          metadataKeys = new Set();
        }
      }
      continue;
    }

    // Edge statements, in either spelling.
    const edge = parseEdge(line);
    if (edge) {
      statements.push(edge);
      continue;
    }

    diagnostics.push(
      lineDiagnostic(
        line,
        `Unsupported syntax: "${line.text.trim()}"`,
        EventFlowDiagnosticCode.UnsupportedSyntax,
      ),
    );
  }

  if (metadataTarget) {
    const open = metadataTarget;
    diagnostics.push({
      severity: "error",
      message: `"${"name" in open ? open.name : open.id}" opens a metadata block that is never closed with \`}\``,
      code: EventFlowDiagnosticCode.UnclosedMetadata,
      range: open.range,
    });
  }

  return {
    flow: {
      title,
      statements,
      ...(handlers.length || inputs.length || outputs.length || effects.length
        ? { causal: { handlers, inputs, outputs, effects } }
        : {}),
    },
    diagnostics,
  };
}

type CausalLine =
  | { kind: "handler"; value: EventFlowHandler; opensMetadata: boolean }
  | { kind: "input"; value: HandlerInput; opensMetadata: false }
  | { kind: "output"; value: HandlerOutput; opensMetadata: false }
  | { kind: "effect"; value: HandlerEffect; opensMetadata: boolean };

/** Causal lines use explicit references; no topology or adjacency is consulted. */
function parseCausalLine(line: EventFlowLine): CausalLine | "malformed" | null {
  const words = line.tokens.filter((token) => token.type === "word");
  const values = words.map((word) => word.value.toLowerCase());
  const range = lineRange(line);
  const opensMetadata = line.tokens.some((token) => token.type === "braceOpen");

  if (values[0] === "handler") {
    const id = words[1];
    if (!id || (words[2] && !["in", "as"].includes(values[2])))
      return "malformed";
    const service = values[2] === "in" ? words[3]?.value : undefined;
    if (values[2] === "in" && !service) return "malformed";
    return {
      kind: "handler",
      opensMetadata,
      value: { type: "handler", id: id.value, service, metadata: [], range },
    };
  }

  if (values[1] === "handled" && values[2] === "by" && words[3]) {
    return {
      kind: "input",
      opensMetadata: false,
      value: {
        type: "handler-input",
        event: words[0].value,
        handlerId: words[3].value,
        range,
      },
    };
  }
  if (values[1] === "handles" && words[2]) {
    return {
      kind: "input",
      opensMetadata: false,
      value: {
        type: "handler-input",
        handlerId: words[0].value,
        event: words[2].value,
        range,
      },
    };
  }
  if (values[1] === "causes" && words[2]) {
    return {
      kind: "output",
      opensMetadata: false,
      value: {
        type: "handler-output",
        handlerId: words[0].value,
        event: words[2].value,
        range,
      },
    };
  }

  const effectAt = values[0] === "effect" ? 0 : values[1] === "effect" ? 1 : -1;
  if (effectAt !== -1) {
    const id = words[effectAt + 1];
    const on = values.indexOf("on");
    const handler =
      on > effectAt ? words[on + 1] : effectAt === 1 ? words[0] : undefined;
    const colon = line.tokens.find((token) => token.type === "colon");
    if (!id || !handler || (!colon && !opensMetadata)) return "malformed";
    const kindAt = values.indexOf("kind");
    const kind = kindAt === -1 ? undefined : words[kindAt + 1]?.value;
    const description = colon
      ? line.text.slice(colon.range.end.column).trim()
      : "";
    return {
      kind: "effect",
      opensMetadata,
      value: {
        type: "effect",
        id: id.value,
        handlerId: handler.value,
        kind,
        description,
        metadata: [],
        range,
      },
    };
  }

  if (
    ["handler", "handled", "handles", "causes", "effect"].includes(
      values[0] ?? "",
    ) ||
    values.includes("handled")
  )
    return "malformed";
  return null;
}

/** Normalize the one conventional metadata value with user-facing semantics. */
function parseDescription(value: string): { value: string; valid: boolean } {
  if (value === "") return { value: "", valid: true };
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return { value, valid: true };
  if (value.length < 2 || value[value.length - 1] !== quote)
    return { value, valid: false };
  return {
    value: value
      .slice(1, -1)
      .replaceAll(`\\${quote}`, quote)
      .replaceAll(`\\\\`, "\\")
      .trim(),
    valid: true,
  };
}

/**
 * Parse a publish/consume line, or return `null` when the line is neither.
 *
 * Both spellings are handled here so the two forms cannot drift apart:
 *
 * ```
 * <Service> publishes <Event> [to <Channel>]
 * <Service> consumes  <Event> [from <Channel>]
 * publish <Event> from <Service> [to <Channel>]
 * consume <Event> by <Service> [from <Channel>]
 * ```
 */
function parseEdge(
  line: EventFlowLine,
): EventPublication | EventSubscription | null {
  const tokens = line.tokens;
  const words = tokens.filter((token) => token.type === "word");
  const range = lineRange(line);

  /** The value of the word following `keyword`, if it is present. */
  const after = (keyword: string): string | undefined => {
    const index = words.findIndex(
      (word) => word.value.toLowerCase() === keyword,
    );
    return index === -1 ? undefined : words[index + 1]?.value;
  };

  // Subject-first: `<Service> publishes <Event> [to <Channel>]`.
  const verbIndex = words.findIndex((word) => {
    const value = word.value.toLowerCase();
    return value === "publishes" || value === "consumes";
  });
  if (verbIndex === 1 && words.length >= 3) {
    const producer = words[0].value;
    const isPublish = words[1].value.toLowerCase() === "publishes";
    const event = words[2].value;
    const channel = after(isPublish ? "to" : "from");
    return isPublish
      ? { type: "publication", producer, event, channel, range }
      : { type: "subscription", consumer: producer, event, channel, range };
  }

  // Verb-first: `publish <Event> from <Service> [to <Channel>]`.
  const head = words[0]?.value.toLowerCase();
  if ((head === "publish" || head === "consume") && words.length >= 3) {
    const event = words[1]?.value;
    const agent = after(head === "publish" ? "from" : "by");
    if (event && agent) {
      const channel = after(head === "publish" ? "to" : "from");
      return head === "publish"
        ? { type: "publication", producer: agent, event, channel, range }
        : { type: "subscription", consumer: agent, event, channel, range };
    }
  }

  return null;
}

/**
 * Validate a parsed document's semantics.
 *
 * Everything here needs only the document, never the rest of the project, so it
 * runs on every keystroke in the editor and is reported per file by the project
 * index. The checks are the ones an event-driven design actually gets wrong:
 * a name that was never declared, an event nobody publishes, a channel nothing
 * consumes, and a service that does neither.
 */
export function validateEventFlow(flow: EventFlow): EventFlowDiagnostic[] {
  const diagnostics: EventFlowDiagnostic[] = [];
  const events = declaredEvents(flow.statements);
  const services = declaredServices(flow.statements);
  const channels = declaredChannels(flow.statements);
  const brokers = declaredBrokers(flow.statements);

  const publications = flow.statements.filter(
    (statement): statement is EventPublication =>
      statement.type === "publication",
  );
  const subscriptions = flow.statements.filter(
    (statement): statement is EventSubscription =>
      statement.type === "subscription",
  );
  const channelDeclarations = flow.statements.filter(
    (statement): statement is ChannelDeclaration =>
      statement.type === "channel",
  );
  const declarations = flow.statements.filter(
    (statement): statement is ServiceDeclaration =>
      statement.type === "service",
  );

  for (const statement of [...publications, ...subscriptions]) {
    const agent =
      statement.type === "publication"
        ? statement.producer
        : statement.consumer;
    if (!services.has(agent)) {
      diagnostics.push({
        severity: "error",
        message: `Unknown service "${agent}" — declare it with \`service ${agent}\``,
        code: EventFlowDiagnosticCode.UnknownService,
        range: statement.range,
      });
    }
    if (!events.has(statement.event)) {
      diagnostics.push({
        severity: "error",
        message: `Unknown event "${statement.event}" — declare it with \`event ${statement.event}\``,
        code: EventFlowDiagnosticCode.UnknownEvent,
        range: statement.range,
      });
    }
    if (statement.channel !== undefined && !channels.has(statement.channel)) {
      diagnostics.push({
        severity: "error",
        message: `Unknown channel "${statement.channel}" — declare it with \`topic ${statement.channel}\``,
        code: EventFlowDiagnosticCode.UnknownChannel,
        range: statement.range,
      });
    }
  }

  for (const channel of channelDeclarations) {
    if (channel.broker !== undefined && !brokers.has(channel.broker)) {
      diagnostics.push({
        severity: "error",
        message: `Channel "${channel.name}" names broker "${channel.broker}", which is not declared`,
        code: EventFlowDiagnosticCode.UnknownBroker,
        range: channel.range,
      });
    }
  }

  // Architecture checks: what a reader of this document would want to know.
  const published = new Set(publications.map((entry) => entry.event));
  const consumed = new Set(subscriptions.map((entry) => entry.event));
  const usedChannels = new Set(
    [...publications, ...subscriptions]
      .map((entry) => entry.channel)
      .filter((channel): channel is string => channel !== undefined),
  );

  for (const event of flow.statements) {
    if (event.type !== "event") continue;
    if (!published.has(event.name)) {
      diagnostics.push({
        severity: "warning",
        message: `Event "${event.name}" has no producer`,
        code: EventFlowDiagnosticCode.EventWithoutProducer,
        range: event.range,
      });
    } else if (!consumed.has(event.name)) {
      diagnostics.push({
        severity: "warning",
        message: `Event "${event.name}" is published but nothing consumes it`,
        code: EventFlowDiagnosticCode.EventWithoutConsumer,
        range: event.range,
      });
    }
  }

  for (const channel of channelDeclarations) {
    if (!usedChannels.has(channel.name)) {
      diagnostics.push({
        severity: "warning",
        message: `Channel "${channel.name}" has no producer or consumer`,
        code: EventFlowDiagnosticCode.ChannelWithoutConsumer,
        range: channel.range,
      });
    }
  }

  const busy = new Set([
    ...publications.map((entry) => entry.producer),
    ...subscriptions.map((entry) => entry.consumer),
  ]);
  for (const declaration of declarations) {
    if (!busy.has(declaration.name)) {
      diagnostics.push({
        severity: "info",
        message: `Service "${declaration.name}" neither publishes nor consumes anything`,
        code: EventFlowDiagnosticCode.UnusedService,
        range: declaration.range,
      });
    }
  }

  for (const violation of validateEventFlowCausality(flow)) {
    const code: EventFlowDiagnosticCode = {
      "duplicate-handler": EventFlowDiagnosticCode.DuplicateHandler,
      "duplicate-input": EventFlowDiagnosticCode.DuplicateCausalInput,
      "duplicate-output": EventFlowDiagnosticCode.DuplicateCausalOutput,
      "duplicate-effect": EventFlowDiagnosticCode.DuplicateEffect,
      "unknown-handler": EventFlowDiagnosticCode.UnknownHandler,
      "unknown-event": EventFlowDiagnosticCode.CausalUnknownEvent,
      "effect-without-handler": EventFlowDiagnosticCode.EffectWithoutHandler,
    }[violation.code];
    diagnostics.push({
      severity: "error",
      message: violation.message,
      code,
      range: violation.reference.range,
    });
  }

  return diagnostics;
}

/**
 * Parse and validate a document in one step — the entry point the editor, the
 * index and any future tool should call.
 */
export function analyzeEventFlow(source: string): EventFlowParseResult {
  const parsed = parseEventFlow(source);
  return {
    flow: parsed.flow,
    diagnostics: [...parsed.diagnostics, ...validateEventFlow(parsed.flow)],
  };
}

/** The span of a publication's or subscription's event name, for navigation. */
export function edgeEventRange(
  statement: EventPublication | EventSubscription,
): SourceRange {
  return statement.range;
}

/** Every name a document mentions, for completion. */
export function eventFlowNames(flow: EventFlow): {
  events: string[];
  services: string[];
  channels: string[];
  brokers: string[];
} {
  return {
    events: [...declaredEvents(flow.statements)],
    services: [...declaredServices(flow.statements)],
    channels: [...declaredChannels(flow.statements)],
    brokers: [...declaredBrokers(flow.statements)],
  };
}

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
  CausalInitiation,
  CausalInitiationKind,
  MessageKind,
  EventFlowFailure,
  EventFlowRetry,
  FailureClassification,
  RetryMechanism,
  RetryTarget,
  RetryBackoff,
  RetryExhaustion,
  FailureTarget,
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
  InvalidMessageKind = "eventflow.invalid-message-kind",
  MalformedCausalRelationship = "eventflow.malformed-causal-relationship",
  DuplicateFailure = "eventflow.duplicate-failure",
  DuplicateRetry = "eventflow.duplicate-retry",
  UnknownFailure = "eventflow.unknown-failure",
  UnknownFailureTarget = "eventflow.unknown-failure-target",
  InvalidFailureValue = "eventflow.invalid-failure-value",
  InvalidRetryPolicy = "eventflow.invalid-retry-policy",
  RetryWithoutContext = "eventflow.retry-without-context",
  ContradictoryRetry = "eventflow.contradictory-retry",
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
const MESSAGE_KINDS = new Set<MessageKind>(["event", "command"]);
const INITIATION_KINDS = new Set<CausalInitiationKind>([
  "scheduled",
  "external",
  "manual",
  "startup",
  "unknown",
]);
const FAILURE_CLASSES = new Set<FailureClassification>(["delivery", "processing", "external-dependency", "business", "timeout", "unknown"]);
const RETRY_MECHANISMS = new Set<RetryMechanism>(["broker", "handler", "application", "scheduler", "external", "unknown"]);
const RETRY_TARGETS = new Set<RetryTarget>(["same-delivery", "same-execution", "new-message"]);
const RETRY_BACKOFFS = new Set<RetryBackoff>(["constant", "linear", "exponential", "unknown"]);
const RETRY_EXHAUSTIONS = new Set<RetryExhaustion>(["dead-letter", "park", "discard", "manual", "terminal-failure", "unknown"]);

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
  const failures: EventFlowFailure[] = [];
  const retries: EventFlowRetry[] = [];
  const initiations: CausalInitiation[] = [];
  let title: EventFlowTitle | undefined;

  /** The event whose metadata block is open, if any. */
  let metadataTarget:
    | EventDeclaration | EventFlowHandler | HandlerEffect | EventFlowFailure | EventFlowRetry | null = null;
  let metadataKeys = new Set<string>();
  let detailsLines: string[] | null = null;
  let detailsEntry: EventMetadataEntry | null = null;

  const closeMetadata = (): void => {
    metadataTarget = null;
    metadataKeys = new Set<string>();
    detailsLines = null;
    detailsEntry = null;
  };

  for (const line of lines) {
    const tokens = line.tokens;
    if (tokens.length === 0 && !line.documentation) continue;
    const first = tokens[0];

    // Entity blocks contain metadata lines, or a retained details body.
    if (metadataTarget) {
      const target = metadataTarget;
      if (detailsLines && line.documentation === "body") {
        detailsLines.push(line.text);
        continue;
      }
      if (detailsLines && line.documentation === "close") {
        const details = normalizeDetails(detailsLines);
        if (details !== "") target.details = details;
        if (detailsEntry) {
          detailsEntry.value = details;
          detailsEntry.range = lineRange(line);
        }
        target.range = { start: target.range!.start, end: lineRange(line).end };
        detailsLines = null;
        detailsEntry = null;
        continue;
      }
      if (first?.type === "braceClose") {
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
        if (key.toLowerCase() === "details" && line.documentation === "open") {
          detailsLines = [];
          detailsEntry = entry;
          metadataKeys.add(key.toLowerCase());
          target.range = {
            start: metadataTarget.range!.start,
            end: entry.range.end,
          };
          continue;
        }
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
        if (target.type === "event" && key.toLowerCase() === "kind") {
          if (!MESSAGE_KINDS.has(value as MessageKind)) {
            diagnostics.push({
              severity: "error",
              message: `Invalid message kind "${value}"; use event or command`,
              code: EventFlowDiagnosticCode.InvalidMessageKind,
              range: entry.range,
            });
          } else if (!metadataKeys.has("kind")) {
            target.kind = value as MessageKind;
          }
        }
        if (target.type === "event" && key.toLowerCase() === "messageref") {
          if (value === "") {
            diagnostics.push(
              lineDiagnostic(
                line,
                "messageRef requires a stable semantic message id",
                EventFlowDiagnosticCode.MalformedDeclaration,
              ),
            );
          } else if (!metadataKeys.has("messageref")) {
            target.messageRef = value;
          }
        }
        if (target.type === "effect" && key.toLowerCase() === "kind") {
          target.kind = value;
        }
        if (target.type === "failure") applyFailureMetadata(target, key, value, entry, diagnostics);
        if (target.type === "retry") applyRetryMetadata(target, key, value, entry, diagnostics);
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
      const allowsMessageRef = keyword === "event" &&
        trailing?.value.toLowerCase() === "messageref";
      if (trailing && !opensMetadata && !allowsTail && !allowsMessageRef) {
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
        if (allowsMessageRef && tokens[3]?.type === "word") {
          declaration.messageRef = tokens[3].value;
        } else if (allowsMessageRef) {
          diagnostics.push(lineDiagnostic(line, "messageRef requires a stable semantic message id", EventFlowDiagnosticCode.MalformedDeclaration));
        }
        statements.push(declaration);
        if (opensMetadata) {
          metadataTarget = declaration;
          metadataKeys = new Set();
          // Persisted Event Flow documents use the compact form
          // `event Name { messageRef id`, before the remaining metadata lines.
          if (tokens[3]?.value.toLowerCase() === "messageref") {
            const reference = tokens[4];
            if (reference?.type === "word") {
              declaration.messageRef = reference.value;
              declaration.metadata.push({
                key: "messageRef",
                value: reference.value,
                range: lineRange(line),
              });
              metadataKeys.add("messageref");
            } else {
              diagnostics.push(lineDiagnostic(line, "messageRef requires a stable semantic message id", EventFlowDiagnosticCode.MalformedDeclaration));
            }
          }
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
      else if (causal.kind === "initiation") initiations.push(causal.value);
      else if (causal.kind === "failure") {
        failures.push(causal.value);
        if (causal.opensMetadata) { metadataTarget = causal.value; metadataKeys = new Set(); }
      } else if (causal.kind === "retry") {
        retries.push(causal.value);
        if (causal.opensMetadata) { metadataTarget = causal.value; metadataKeys = new Set(); }
      } else {
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
      ...(handlers.length || inputs.length || outputs.length || effects.length || initiations.length || failures.length || retries.length
        ? { causal: { handlers, inputs, outputs, effects, initiations, failures, retries } }
        : {}),
    },
    diagnostics,
  };
}

type CausalLine =
  | { kind: "handler"; value: EventFlowHandler; opensMetadata: boolean }
  | { kind: "input"; value: HandlerInput; opensMetadata: false }
  | { kind: "output"; value: HandlerOutput; opensMetadata: false }
  | { kind: "initiation"; value: CausalInitiation; opensMetadata: false }
  | { kind: "failure"; value: EventFlowFailure; opensMetadata: boolean }
  | { kind: "retry"; value: EventFlowRetry; opensMetadata: boolean }
  | { kind: "effect"; value: HandlerEffect; opensMetadata: boolean };

/** Causal lines use explicit references; no topology or adjacency is consulted. */
function parseCausalLine(line: EventFlowLine): CausalLine | "malformed" | null {
  const words = line.tokens.filter((token) => token.type === "word");
  const values = words.map((word) => word.value.toLowerCase());
  const range = lineRange(line);
  const opensMetadata = line.tokens.some((token) => token.type === "braceOpen");

  if (values[0] === "failure") {
    const id = words[1];
    const on = values.indexOf("on");
    const targetKind = values[on + 1];
    const targetId = words[on + 2];
    if (!id || on < 0 || !targetId || !["handler", "effect", "message"].includes(targetKind ?? "")) return "malformed";
    return { kind: "failure", opensMetadata, value: { type: "failure", id: id.value, target: { kind: targetKind as FailureTarget["kind"], id: targetId.value }, metadata: [], range } };
  }
  if (values[0] === "retry") {
    const id = words[1];
    const forIndex = values.indexOf("for");
    const failure = words[forIndex + 1];
    if (!id || forIndex < 0 || !failure) return "malformed";
    return { kind: "retry", opensMetadata, value: { type: "retry", id: id.value, failureId: failure.value, metadata: [], range } };
  }

  if (values[1] === "initiates" && words[2]) {
    const kind = values[0] as CausalInitiationKind;
    if (!INITIATION_KINDS.has(kind)) return "malformed";
    return {
      kind: "initiation",
      opensMetadata: false,
      value: { type: "initiation", kind, message: words[2].value, range },
    };
  }

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
      ? line.text
          .slice(colon.range.end.column)
          .trim()
          .replace(/\s*\{$/, "")
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
    ["handler", "handled", "handles", "causes", "effect", "failure", "retry", "scheduled", "external", "manual", "startup", "unknown"].includes(
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

function normalizeDetails(lines: string[]): string {
  const trimmed = [...lines];
  while (trimmed[0]?.trim() === "") trimmed.shift();
  while (trimmed.at(-1)?.trim() === "") trimmed.pop();
  const indents = trimmed
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return trimmed.map((line) => line.slice(indent)).join("\n");
}

function applyFailureMetadata(
  target: EventFlowFailure,
  key: string,
  value: string,
  entry: EventMetadataEntry,
  diagnostics: EventFlowDiagnostic[],
): void {
  if (key.toLowerCase() === "classification") {
    if (!FAILURE_CLASSES.has(value as FailureClassification)) diagnostics.push({ severity: "error", message: `Invalid failure classification "${value}"`, code: EventFlowDiagnosticCode.InvalidFailureValue, range: entry.range });
    else target.classification = value as FailureClassification;
  }
  if (key.toLowerCase() === "owner") {
    if (!RETRY_MECHANISMS.has(value as RetryMechanism)) diagnostics.push({ severity: "error", message: `Invalid failure owner "${value}"`, code: EventFlowDiagnosticCode.InvalidFailureValue, range: entry.range });
    else target.owner = value as RetryMechanism;
  }
}

function applyRetryMetadata(
  target: EventFlowRetry,
  key: string,
  value: string,
  entry: EventMetadataEntry,
  diagnostics: EventFlowDiagnostic[],
): void {
  const invalid = (message: string) => diagnostics.push({ severity: "error", message, code: EventFlowDiagnosticCode.InvalidRetryPolicy, range: entry.range });
  switch (key.toLowerCase()) {
    case "mechanism": if (RETRY_MECHANISMS.has(value as RetryMechanism)) target.mechanism = value as RetryMechanism; else invalid(`Invalid retry mechanism "${value}"`); break;
    case "target": if (RETRY_TARGETS.has(value as RetryTarget)) target.target = value as RetryTarget; else invalid(`Invalid retry target "${value}"`); break;
    case "initiates": target.initiates = value; target.target = "new-message"; break;
    case "max-attempts": { const count = Number(value); if (!Number.isInteger(count) || count < 1) invalid("max-attempts must be a positive integer"); else target.maxAttempts = count; break; }
    case "delay": if (/^\d+(ms|s|m|h|d)$/.test(value)) target.delay = value; else invalid("delay must be a positive duration such as 250ms or 2s"); break;
    case "backoff": if (RETRY_BACKOFFS.has(value as RetryBackoff)) target.backoff = value as RetryBackoff; else invalid(`Invalid retry backoff "${value}"`); break;
    case "timeout": if (/^\d+(ms|s|m|h|d)$/.test(value)) target.timeout = value; else invalid("timeout must be a positive duration such as 250ms or 2s"); break;
    case "exhaustion": if (RETRY_EXHAUSTIONS.has(value as RetryExhaustion)) target.exhaustion = value as RetryExhaustion; else invalid(`Invalid exhaustion behavior "${value}"`); break;
  }
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
       "duplicate-failure": EventFlowDiagnosticCode.DuplicateFailure,
       "duplicate-retry": EventFlowDiagnosticCode.DuplicateRetry,
       "unknown-failure": EventFlowDiagnosticCode.UnknownFailure,
       "retry-without-context": EventFlowDiagnosticCode.RetryWithoutContext,
       "contradictory-retry": EventFlowDiagnosticCode.ContradictoryRetry,
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

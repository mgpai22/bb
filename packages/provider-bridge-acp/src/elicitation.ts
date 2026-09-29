import { randomUUID } from "node:crypto";
import {
  isApprovalPendingInteractionResolution,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  userQuestionPendingInteractionResolutionSchema,
} from "@bb/domain";
import type {
  PendingInteractionPayload,
  PendingInteractionResolution,
  PendingInteractionUserAnswer,
  PendingInteractionUserQuestionQuestion,
} from "@bb/domain";
import { z } from "zod";

const acpElicitationChoiceSchema = z
  .object({
    const: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const acpElicitationPropertySchema = z
  .object({
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    enum: z.array(z.string().min(1)).optional(),
    oneOf: z.array(acpElicitationChoiceSchema).optional(),
    items: z
      .object({
        enum: z.array(z.string().min(1)).optional(),
        anyOf: z.array(acpElicitationChoiceSchema).optional(),
      })
      .passthrough()
      .optional(),
    default: z.unknown().optional(),
  })
  .passthrough();
type AcpElicitationProperty = z.infer<typeof acpElicitationPropertySchema>;

export const acpElicitationCreateParamsSchema = z
  .object({
    mode: z.string(),
    sessionId: z.string(),
    message: z.string(),
    requestedSchema: z
      .object({
        properties: z.record(z.string(), acpElicitationPropertySchema),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type AcpElicitationCreateParams = z.infer<
  typeof acpElicitationCreateParamsSchema
>;

type AcpElicitationValue = string | boolean | string[];

export type AcpElicitationResponse =
  | { action: "accept"; content: Record<string, AcpElicitationValue> }
  | { action: "decline" }
  | { action: "cancel" };

interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

type ElicitationField =
  | {
      kind: "choice";
      key: string;
      multi: boolean;
      options: ChoiceOption[];
      otherKey: string | undefined;
    }
  | { kind: "boolean"; key: string }
  | { kind: "text"; key: string; defaultText: string | undefined };

export type AcpElicitationRequest =
  | { kind: "plan"; payload: PendingInteractionPayload }
  | {
      kind: "questions";
      fields: ElicitationField[];
      batches: PendingInteractionPayload[];
    }
  | { kind: "unsupported" };

const OMP_PLAN_APPROVE = "Approve and execute";
const OMP_PLAN_REFINE = "Refine plan";
const OTHER_KEY_SUFFIX = "__other";
const USE_DEFAULT_VALUE = "default";
const BOOLEAN_OPTIONS: ChoiceOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
];

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function choiceOptions(
  property: AcpElicitationProperty,
): ChoiceOption[] | undefined {
  const source =
    property.type === "array"
      ? (property.items?.anyOf ?? property.items?.enum)
      : (property.oneOf ?? property.enum);
  if (source === undefined || source.length === 0) {
    return undefined;
  }
  return source.map((entry) => {
    if (typeof entry === "string") {
      return { value: entry, label: entry };
    }
    const description = nonBlank(entry.description);
    return {
      value: entry.const,
      label: nonBlank(entry.title) ?? entry.const,
      ...(description === undefined ? {} : { description }),
    };
  });
}

function isPlanApproval(
  properties: Record<string, AcpElicitationProperty>,
): boolean {
  const keys = Object.keys(properties);
  const values = properties["value"]?.enum;
  return (
    keys.length === 1 &&
    values?.length === 2 &&
    values[0] === OMP_PLAN_APPROVE &&
    values[1] === OMP_PLAN_REFINE
  );
}

function planApprovalPayload(message: string): PendingInteractionPayload {
  const [heading = "", ...rest] = message.split("\n\n");
  const plan = nonBlank(rest.join("\n\n")) ?? nonBlank(message) ?? "Plan";
  return {
    kind: "approval",
    subject: {
      kind: "plan",
      itemId: `acp-elicitation-${randomUUID()}`,
      plan,
      planFilePath: null,
    },
    reason: nonBlank(heading) ?? null,
    availableDecisions: ["allow_once", "deny"],
  };
}

function fieldFor(
  key: string,
  property: AcpElicitationProperty,
  otherKey: string | undefined,
): ElicitationField | undefined {
  if (property.type === "boolean") {
    return { kind: "boolean", key };
  }
  const options = choiceOptions(property);
  if (options !== undefined) {
    return {
      kind: "choice",
      key,
      multi: property.type === "array",
      options,
      otherKey,
    };
  }
  if (property.type === "string") {
    return {
      kind: "text",
      key,
      defaultText:
        typeof property.default === "string"
          ? nonBlank(property.default)
          : undefined,
    };
  }
  return undefined;
}

function questionFor(
  field: ElicitationField,
  property: AcpElicitationProperty,
  prompt: string,
): PendingInteractionUserQuestionQuestion {
  switch (field.kind) {
    case "boolean":
      return {
        id: field.key,
        prompt,
        multiSelect: false,
        options: BOOLEAN_OPTIONS,
        allowFreeText: false,
      };
    case "text":
      return {
        id: field.key,
        prompt,
        multiSelect: false,
        ...(field.defaultText === undefined
          ? {}
          : {
              options: [
                {
                  value: USE_DEFAULT_VALUE,
                  label: "Use default",
                  description: field.defaultText,
                },
              ],
            }),
        allowFreeText: true,
      };
    case "choice": {
      const shortLabel = nonBlank(property.description);
      const header = shortLabel === undefined ? {} : { shortLabel };
      if (field.options.length > USER_QUESTION_MAX_OPTIONS) {
        const listed = field.options.map((option) => `- ${option.label}`);
        const hint = field.multi
          ? "Type one or more options, separated by commas"
          : "Type one option";
        return {
          id: field.key,
          prompt: `${prompt}\n\n${hint}:\n${listed.join("\n")}`,
          ...header,
          multiSelect: false,
          allowFreeText: true,
        };
      }
      return {
        id: field.key,
        prompt,
        ...header,
        multiSelect: field.multi,
        options: field.options.map((option) =>
          option.value === property.default
            ? { ...option, label: `${option.label} (recommended)` }
            : option,
        ),
        allowFreeText: field.otherKey !== undefined,
      };
    }
  }
}

export function buildAcpElicitationRequest(
  params: AcpElicitationCreateParams,
): AcpElicitationRequest {
  const properties = params.requestedSchema?.properties ?? {};
  if (params.mode !== "form" || Object.keys(properties).length === 0) {
    return { kind: "unsupported" };
  }
  if (isPlanApproval(properties)) {
    return { kind: "plan", payload: planApprovalPayload(params.message) };
  }
  const entries = Object.entries(properties).filter(
    ([key]) =>
      !key.endsWith(OTHER_KEY_SUFFIX) ||
      properties[key.slice(0, -OTHER_KEY_SUFFIX.length)] === undefined,
  );
  const fields: ElicitationField[] = [];
  const questions: PendingInteractionUserQuestionQuestion[] = [];
  for (const [key, property] of entries) {
    const otherKey =
      properties[`${key}${OTHER_KEY_SUFFIX}`] === undefined
        ? undefined
        : `${key}${OTHER_KEY_SUFFIX}`;
    const field = fieldFor(key, property, otherKey);
    if (field === undefined) {
      return { kind: "unsupported" };
    }
    const prompt =
      nonBlank(property.title) ??
      (entries.length === 1 ? nonBlank(params.message) : undefined) ??
      key;
    fields.push(field);
    questions.push(questionFor(field, property, prompt));
  }
  const batches: PendingInteractionPayload[] = [];
  for (
    let index = 0;
    index < questions.length;
    index += USER_QUESTION_MAX_QUESTIONS
  ) {
    batches.push({
      kind: "user_question",
      questions: questions.slice(index, index + USER_QUESTION_MAX_QUESTIONS),
    });
  }
  return { kind: "questions", fields, batches };
}

export function acpPlanElicitationResponse(
  resolution: PendingInteractionResolution | undefined,
): AcpElicitationResponse {
  if (
    resolution === undefined ||
    !isApprovalPendingInteractionResolution(resolution)
  ) {
    return { action: "cancel" };
  }
  return {
    action: "accept",
    content: {
      value:
        resolution.decision === "deny" ? OMP_PLAN_REFINE : OMP_PLAN_APPROVE,
    },
  };
}

export function parseAcpElicitationAnswers(
  resolution: PendingInteractionResolution | undefined,
): Record<string, PendingInteractionUserAnswer> | undefined {
  const parsed =
    userQuestionPendingInteractionResolutionSchema.safeParse(resolution);
  return parsed.success ? parsed.data.answers : undefined;
}

function choiceContent(
  field: Extract<ElicitationField, { kind: "choice" }>,
  answer: PendingInteractionUserAnswer,
): Record<string, AcpElicitationValue> {
  const selected: string[] = [];
  let other = answer.freeText;
  if (field.options.length > USER_QUESTION_MAX_OPTIONS) {
    const typed = other ?? "";
    const unmatched: string[] = [];
    for (const token of field.multi ? typed.split(/[,\n]/u) : [typed]) {
      const wanted = token.trim().toLowerCase();
      const option = field.options.find(
        (candidate) =>
          candidate.value.toLowerCase() === wanted ||
          candidate.label.toLowerCase() === wanted,
      );
      if (option !== undefined) {
        selected.push(option.value);
      } else if (wanted !== "") {
        unmatched.push(token.trim());
      }
    }
    other = unmatched.length > 0 ? unmatched.join(", ") : undefined;
  } else {
    const values = new Set(field.options.map((option) => option.value));
    selected.push(...answer.selected.filter((value) => values.has(value)));
  }
  const content: Record<string, AcpElicitationValue> = {};
  const [firstSelected] = selected;
  if (firstSelected !== undefined) {
    content[field.key] = field.multi ? selected : firstSelected;
  }
  if (other !== undefined) {
    if (field.otherKey !== undefined) {
      content[field.otherKey] = other;
    } else if (!field.multi && firstSelected === undefined) {
      content[field.key] = other;
    }
  }
  return content;
}

function fieldContent(
  field: ElicitationField,
  answer: PendingInteractionUserAnswer,
): Record<string, AcpElicitationValue> {
  const [first] = answer.selected;
  switch (field.kind) {
    case "boolean":
      return first === undefined ? {} : { [field.key]: first === "true" };
    case "text":
      if (first === USE_DEFAULT_VALUE && field.defaultText !== undefined) {
        return { [field.key]: field.defaultText };
      }
      return answer.freeText === undefined
        ? {}
        : { [field.key]: answer.freeText };
    case "choice":
      return choiceContent(field, answer);
  }
}

export function acpQuestionsElicitationResponse(
  fields: readonly ElicitationField[],
  answers: Record<string, PendingInteractionUserAnswer>,
): AcpElicitationResponse {
  const content: Record<string, AcpElicitationValue> = {};
  for (const field of fields) {
    const answer = answers[field.key];
    if (answer !== undefined) {
      Object.assign(content, fieldContent(field, answer));
    }
  }
  return Object.keys(content).length === 0
    ? { action: "decline" }
    : { action: "accept", content };
}

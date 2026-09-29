import { describe, expect, it } from "vitest";
import {
  acpElicitationCreateParamsSchema,
  acpQuestionsElicitationResponse,
  buildAcpElicitationRequest,
  type AcpElicitationRequest,
} from "./elicitation.js";

function questionsRequest(
  properties: Record<string, object>,
  message = "Pick",
): Extract<AcpElicitationRequest, { kind: "questions" }> {
  const request = buildAcpElicitationRequest(
    acpElicitationCreateParamsSchema.parse({
      mode: "form",
      sessionId: "s",
      message,
      requestedSchema: { type: "object", properties },
    }),
  );
  if (request.kind !== "questions") {
    throw new Error(`expected questions, got ${request.kind}`);
  }
  return request;
}

const SIX_MODELS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

describe("buildAcpElicitationRequest", () => {
  it("declines url mode and property types it cannot render", () => {
    expect(
      buildAcpElicitationRequest({
        mode: "url",
        sessionId: "s",
        message: "Open",
        requestedSchema: { properties: { value: { type: "string" } } },
      }),
    ).toEqual({ kind: "unsupported" });
    expect(
      buildAcpElicitationRequest({
        mode: "form",
        sessionId: "s",
        message: "Count?",
        requestedSchema: { properties: { value: { type: "number" } } },
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("splits more than four questions into sequential batches", () => {
    const properties = Object.fromEntries(
      [0, 1, 2, 3, 4].map((index) => [
        `q${index}`,
        { type: "string", title: `Question ${index}` },
      ]),
    );
    const request = questionsRequest(properties);
    expect(
      request.batches.map((batch) =>
        batch.kind === "user_question"
          ? batch.questions.map((question) => question.id)
          : [],
      ),
    ).toEqual([["q0", "q1", "q2", "q3"], ["q4"]]);
  });

  it("turns a select with more than four options into typed text", () => {
    const request = questionsRequest(
      { value: { type: "string", enum: SIX_MODELS } },
      "Choose a model",
    );
    expect(request.batches[0]).toEqual({
      kind: "user_question",
      questions: [
        {
          id: "value",
          prompt: `Choose a model\n\nType one option:\n${SIX_MODELS.map((model) => `- ${model}`).join("\n")}`,
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    });
    expect(
      acpQuestionsElicitationResponse(request.fields, {
        value: { selected: [], freeText: " Gamma " },
      }),
    ).toEqual({ action: "accept", content: { value: "gamma" } });
  });

  it("maps typed multi-select text to options and leftovers to other", () => {
    const request = questionsRequest({
      q0: {
        type: "array",
        title: "Which?",
        items: {
          anyOf: SIX_MODELS.map((model) => ({ const: model, title: model })),
        },
      },
      q0__other: { type: "string", title: "Other (type your own)" },
    });
    expect(
      acpQuestionsElicitationResponse(request.fields, {
        q0: { selected: [], freeText: "alpha, zeta, omega" },
      }),
    ).toEqual({
      action: "accept",
      content: { q0: ["alpha", "zeta"], q0__other: "omega" },
    });
  });

  it("offers an editor prefill as a keep-default choice", () => {
    const request = questionsRequest(
      { value: { type: "string", default: "draft body" } },
      "Edit message",
    );
    expect(request.batches[0]).toMatchObject({
      questions: [
        {
          prompt: "Edit message",
          allowFreeText: true,
          options: [
            {
              value: "default",
              label: "Use default",
              description: "draft body",
            },
          ],
        },
      ],
    });
    expect(
      acpQuestionsElicitationResponse(request.fields, {
        value: { selected: ["default"] },
      }),
    ).toEqual({ action: "accept", content: { value: "draft body" } });
    expect(
      acpQuestionsElicitationResponse(request.fields, {
        value: { selected: [], freeText: "new body" },
      }),
    ).toEqual({ action: "accept", content: { value: "new body" } });
  });

  it("asks a question that has only an other field as free text", () => {
    const request = questionsRequest({
      q0__other: { type: "string", title: "Other (type your own)" },
    });
    expect(
      acpQuestionsElicitationResponse(request.fields, {
        q0__other: { selected: [], freeText: "custom" },
      }),
    ).toEqual({ action: "accept", content: { q0__other: "custom" } });
  });
});

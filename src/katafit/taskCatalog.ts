// Pinned coach.tasks.v1 catalog; never compile remote schemas.
export const taskCatalog = {
  protocol: "coach.tasks.v1",
  contracts: [
    {
      kind: "activity_reaction",
      schema_id: "coach.tasks.v1/activity_reaction",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          activity_feedback: {
            type: "object",
            properties: {
              reaction: {
                type: "string",
                enum: [
                  "thumbs_up",
                  "flex",
                  "fire",
                  "trophy",
                  "rocket",
                  "clap",
                  "raised_hands",
                  "check",
                  "salute",
                  "chef_kiss",
                  "bullseye",
                  "lightning",
                  "heart",
                  "star",
                  "hundred",
                  "medal",
                  "eyes",
                  "thinking",
                  "memo",
                  "hourglass",
                  "search",
                  "question",
                  "thumbs_down",
                  "grimace",
                  "facepalm",
                  "warning",
                  "red_flag",
                  "no_entry",
                  "dizzy",
                  "cold",
                  "angry",
                  "punch",
                  "slap",
                  "explosion",
                  "skull",
                  "point",
                ],
              },
              reply_worthwhile: {
                type: "boolean",
              },
            },
            required: ["reaction", "reply_worthwhile"],
            additionalProperties: false,
          },
          general_advice: {
            type: "string",
            maxLength: 8000,
          },
          meal_recommendations: {
            maxItems: 3,
            type: "array",
            items: {
              type: "string",
              maxLength: 1000,
            },
          },
          recovery_recommendations: {
            maxItems: 3,
            type: "array",
            items: {
              type: "string",
              maxLength: 1000,
            },
          },
          day_closeout_meal_assessment: {
            type: "string",
            maxLength: 1000,
          },
        },
        required: ["activity_feedback", "general_advice"],
        additionalProperties: false,
      },
    },
    {
      kind: "activity_followup",
      schema_id: "coach.tasks.v1/activity_followup",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 8000,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      kind: "daily_insight",
      schema_id: "coach.tasks.v1/daily_insight",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          general_advice: {
            type: "string",
            minLength: 1,
            maxLength: 8000,
          },
          meal_recommendations: {
            maxItems: 3,
            type: "array",
            items: {
              type: "string",
              maxLength: 1000,
            },
          },
          recovery_recommendations: {
            maxItems: 3,
            type: "array",
            items: {
              type: "string",
              maxLength: 1000,
            },
          },
          workout_directives: {
            maxItems: 3,
            type: "array",
            items: {
              type: "object",
              properties: {
                activity_id: {
                  type: "string",
                  pattern: "^[a-f0-9]{24}$",
                },
                workout_exercise_id: {
                  type: "string",
                  pattern: "^[a-f0-9]{24}$",
                },
                exercise_id: {
                  type: "string",
                  pattern: "^[a-f0-9]{24}$",
                },
                exercise_name: {
                  type: "string",
                  minLength: 1,
                  maxLength: 160,
                },
                recommendation: {
                  type: "string",
                  maxLength: 1000,
                },
              },
              required: [
                "activity_id",
                "workout_exercise_id",
                "exercise_id",
                "exercise_name",
                "recommendation",
              ],
              additionalProperties: false,
            },
          },
          strategy_nudge: {
            type: "string",
            maxLength: 1000,
          },
          strategy_assessment: {
            anyOf: [
              {
                type: "object",
                properties: {
                  status_summary: {
                    type: "string",
                    maxLength: 1000,
                  },
                  milestones_reached: {
                    maxItems: 3,
                    type: "array",
                    items: {
                      type: "string",
                      maxLength: 1000,
                    },
                  },
                  milestones_upcoming: {
                    maxItems: 3,
                    type: "array",
                    items: {
                      type: "string",
                      maxLength: 1000,
                    },
                  },
                  milestones_overdue: {
                    maxItems: 3,
                    type: "array",
                    items: {
                      type: "string",
                      maxLength: 1000,
                    },
                  },
                  strategy_verdict: {
                    type: "string",
                    enum: ["on_track", "needs_attention", "needs_revision"],
                  },
                  strategy_verdict_reason: {
                    type: "string",
                    maxLength: 1000,
                  },
                },
                required: [
                  "status_summary",
                  "milestones_reached",
                  "milestones_upcoming",
                  "milestones_overdue",
                  "strategy_verdict",
                  "strategy_verdict_reason",
                ],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: [
          "general_advice",
          "meal_recommendations",
          "recovery_recommendations",
          "workout_directives",
        ],
        additionalProperties: false,
      },
    },
    {
      kind: "media_chat",
      schema_id: "coach.tasks.v1/media_chat",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 8000,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      kind: "workout_chat",
      schema_id: "coach.tasks.v1/workout_chat",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 8000,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      kind: "exercise_chat",
      schema_id: "coach.tasks.v1/exercise_chat",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 8000,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      kind: "workout_suggestions",
      schema_id: "coach.tasks.v1/workout_suggestions",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          recommendations: {
            type: "object",
            propertyNames: {
              type: "string",
              pattern: "^[a-f0-9]{24}$",
            },
            additionalProperties: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  maxLength: 1000,
                },
                warmup_weight: {
                  anyOf: [
                    {
                      type: "number",
                      minimum: 0,
                      maximum: 2000,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                warmup_sets: {
                  anyOf: [
                    {
                      type: "integer",
                      minimum: 0,
                      maximum: 20,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                target_weight: {
                  anyOf: [
                    {
                      type: "number",
                      minimum: 0,
                      maximum: 2000,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                target_reps: {
                  anyOf: [
                    {
                      type: "integer",
                      minimum: 0,
                      maximum: 1000,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                target_working_sets: {
                  anyOf: [
                    {
                      type: "integer",
                      minimum: 0,
                      maximum: 30,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                target_volume: {
                  anyOf: [
                    {
                      type: "number",
                      minimum: 0,
                      maximum: 1000000,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                target_duration_seconds: {
                  anyOf: [
                    {
                      type: "integer",
                      minimum: 0,
                      maximum: 86400,
                    },
                    {
                      type: "null",
                    },
                  ],
                },
                intensity: {
                  anyOf: [
                    {
                      type: "string",
                      enum: ["low", "moderate", "high"],
                    },
                    {
                      type: "null",
                    },
                  ],
                },
              },
              required: ["summary"],
              additionalProperties: false,
            },
          },
        },
        required: ["recommendations"],
        additionalProperties: false,
      },
    },
    {
      kind: "exercise_suggestions",
      schema_id: "coach.tasks.v1/exercise_suggestions",
      result_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          summary: {
            type: "string",
            maxLength: 1000,
          },
          reply_worthwhile: {
            type: "boolean",
          },
          reply_reason: {
            anyOf: [
              {
                type: "string",
                enum: [
                  "safety_or_form",
                  "meaningful_performance_change",
                  "progression_adjustment",
                ],
              },
              {
                type: "null",
              },
            ],
          },
          reactions: {
            maxItems: 40,
            type: "array",
            items: {
              type: "object",
              properties: {
                target_event_key: {
                  type: "string",
                  minLength: 1,
                  maxLength: 240,
                },
                reaction: {
                  type: "string",
                  enum: [
                    "thumbs_up",
                    "flex",
                    "fire",
                    "trophy",
                    "rocket",
                    "clap",
                    "raised_hands",
                    "check",
                    "salute",
                    "chef_kiss",
                    "bullseye",
                    "lightning",
                    "heart",
                    "star",
                    "hundred",
                    "medal",
                    "eyes",
                    "thinking",
                    "memo",
                    "hourglass",
                    "search",
                    "question",
                    "thumbs_down",
                    "grimace",
                    "facepalm",
                    "warning",
                    "red_flag",
                    "no_entry",
                    "dizzy",
                    "cold",
                    "angry",
                    "punch",
                    "slap",
                    "explosion",
                    "skull",
                    "point",
                  ],
                },
              },
              required: ["target_event_key", "reaction"],
              additionalProperties: false,
            },
          },
          concern_evidence: {
            anyOf: [
              {
                type: "object",
                properties: {
                  evidence_type: {
                    type: "string",
                    enum: [
                      "form",
                      "pain",
                      "safety",
                      "performance_change",
                      "progression",
                    ],
                  },
                  signal: {
                    type: "string",
                    enum: [
                      "reps",
                      "load",
                      "rir",
                      "rpe",
                      "duration",
                      "tempo",
                      "range_of_motion",
                      "volume",
                      "alignment",
                      "stability",
                      "symmetry",
                      "balance",
                      "control",
                      "pain",
                      "discomfort",
                      "dizziness",
                      "loss_of_control",
                      "equipment",
                      "acute_symptom",
                    ],
                  },
                  polarity: {
                    type: "string",
                    enum: ["present", "absent", "ambiguous"],
                  },
                  target_event_key: {
                    type: "string",
                    minLength: 1,
                    maxLength: 240,
                  },
                  workout_exercise_id: {
                    type: "string",
                    pattern: "^[a-f0-9]{24}$",
                  },
                  set_index: {
                    type: "integer",
                    minimum: 0,
                    maximum: 999,
                  },
                  comparison_role: {
                    type: "string",
                    enum: ["none", "subject"],
                  },
                  comparison_set_indices: {
                    maxItems: 40,
                    type: "array",
                    items: {
                      type: "integer",
                      minimum: 0,
                      maximum: 999,
                    },
                  },
                },
                required: [
                  "evidence_type",
                  "signal",
                  "polarity",
                  "target_event_key",
                  "workout_exercise_id",
                  "set_index",
                  "comparison_role",
                  "comparison_set_indices",
                ],
                additionalProperties: false,
              },
              {
                type: "null",
              },
            ],
          },
          question: {
            anyOf: [
              {
                type: "string",
                maxLength: 1000,
              },
              {
                type: "null",
              },
            ],
          },
          question_type: {
            anyOf: [
              {
                type: "string",
                enum: ["yes_no", "choice", "open"],
              },
              {
                type: "null",
              },
            ],
          },
          question_choices: {
            anyOf: [
              {
                maxItems: 8,
                type: "array",
                items: {
                  type: "string",
                  minLength: 1,
                  maxLength: 200,
                },
              },
              {
                type: "null",
              },
            ],
          },
          warmup_weight: {
            anyOf: [
              {
                type: "number",
                minimum: 0,
                maximum: 2000,
              },
              {
                type: "null",
              },
            ],
          },
          warmup_sets: {
            anyOf: [
              {
                type: "integer",
                minimum: 0,
                maximum: 20,
              },
              {
                type: "null",
              },
            ],
          },
          target_weight: {
            anyOf: [
              {
                type: "number",
                minimum: 0,
                maximum: 2000,
              },
              {
                type: "null",
              },
            ],
          },
          target_reps: {
            anyOf: [
              {
                type: "integer",
                minimum: 0,
                maximum: 1000,
              },
              {
                type: "null",
              },
            ],
          },
          target_working_sets: {
            anyOf: [
              {
                type: "integer",
                minimum: 0,
                maximum: 30,
              },
              {
                type: "null",
              },
            ],
          },
          target_volume: {
            anyOf: [
              {
                type: "number",
                minimum: 0,
                maximum: 1000000,
              },
              {
                type: "null",
              },
            ],
          },
          target_duration_seconds: {
            anyOf: [
              {
                type: "integer",
                minimum: 0,
                maximum: 86400,
              },
              {
                type: "null",
              },
            ],
          },
          intensity: {
            anyOf: [
              {
                type: "string",
                enum: ["low", "moderate", "high"],
              },
              {
                type: "null",
              },
            ],
          },
        },
        required: ["summary", "reply_worthwhile", "reactions"],
        additionalProperties: false,
      },
    },
  ],
} as const;

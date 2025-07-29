import { Request, Response } from "express";
import { ErrorResponse, extractOptions, RequestWithAuth } from "./types";
import { getDeepResearchQueue } from "../../services/queue-service";
import * as Sentry from "@sentry/node";
import { saveDeepResearch } from "../../lib/deep-research/deep-research-redis";
import { z } from "zod";

export const deepResearchRequestSchema = z.object({
  query: z.string().describe('The query or topic to search for').optional(),
  maxDepth: z.number().min(1).max(12).default(7).describe('Maximum depth of research iterations'),
  maxUrls: z.number().min(1).max(1000).default(20).describe('Maximum number of URLs to analyze'),
  timeLimit: z.number().min(30).max(600).default(300).describe('Time limit in seconds'),
  analysisPrompt: z.string().describe('The prompt to use for the final analysis').optional(),
  systemPrompt: z.string().describe('The system prompt to use for the research agent').optional(),
  formats: z.array(z.enum(['markdown', 'json'])).default(['markdown']),
  // @deprecated Use query instead
  topic: z.string().describe('The topic or question to research').optional(),
  jsonOptions: extractOptions.optional(),
}).refine(data => data.query || data.topic, {
  message: "Either query or topic must be provided"
}).refine((obj) => {
  const hasJsonFormat = obj.formats?.includes("json");
  const hasJsonOptions = obj.jsonOptions !== undefined;
  return (hasJsonFormat && hasJsonOptions) || (!hasJsonFormat && !hasJsonOptions);
}, {
  message: "When 'json' format is specified, jsonOptions must be provided, and vice versa"
}).transform(data => ({
  ...data,
  query: data.topic || data.query // Use topic as query if provided
}));

export type DeepResearchRequest = z.infer<typeof deepResearchRequestSchema>;

export type DeepResearchResponse = ErrorResponse | {
  success: boolean;
  id: string;
};

/**
 * Initiates a deep research job based on the provided topic.
 * @param req - The request object containing authentication and research parameters.
 * @param res - The response object to send the research job ID.
 * @returns A promise that resolves when the research job is queued.
 */
export async function deepResearchController(
  req: RequestWithAuth<{}, DeepResearchResponse, DeepResearchRequest>,
  res: Response<DeepResearchResponse>,
) {
  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({ success: false, error: "Your team has zero data retention enabled. This is not supported on deep research. Please contact zardam@dubit.live to unblock this feature." });
  }

  req.body = deepResearchRequestSchema.parse(req.body);

  const researchId = crypto.randomUUID();
  const jobData = {
    request: req.body,
    teamId: req.auth.team_id,
    subId: req.acuc?.sub_id,
    researchId,
  };

  await saveDeepResearch(researchId, {
    id: researchId,
    team_id: req.auth.team_id,
    createdAt: Date.now(),
    status: "processing",
    currentDepth: 0,
    maxDepth: req.body.maxDepth,
    completedSteps: 0,
    totalExpectedSteps: req.body.maxDepth * 5, // 5 steps per depth level
    findings: [],
    sources: [],
    activities: [],
    summaries: [],
  });

  if (Sentry.isInitialized()) {
    const size = JSON.stringify(jobData).length;
    await Sentry.startSpan(
      {
        name: "Add deep research job",
        op: "queue.publish",
        attributes: {
          "messaging.message.id": researchId,
          "messaging.destination.name": getDeepResearchQueue().name,
          "messaging.message.body.size": size,
        },
      },
      async (span) => {
        await getDeepResearchQueue().add(researchId, {
          ...jobData,
          sentry: {
            trace: Sentry.spanToTraceHeader(span),
            baggage: Sentry.spanToBaggageHeader(span),
            size,
          },
        }, { jobId: researchId });
      },
    );
  } else {
    await getDeepResearchQueue().add(researchId, jobData, {
      jobId: researchId,
    });
  }

  return res.status(200).json({
    success: true,
    id: researchId,
  });
}

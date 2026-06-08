// Next.js loads this automatically on server startup. We wire OpenTelemetry only
// in the Node runtime — the Langfuse exporter and the AI SDK calls run there.
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

// Exported so route handlers can force a flush before the serverless function
// freezes — buffered spans would otherwise be lost. Reads LANGFUSE_* from env;
// a no-op exporter when the keys are unset.
export const langfuseSpanProcessor = new LangfuseSpanProcessor();

export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const provider = new NodeTracerProvider({ spanProcessors: [langfuseSpanProcessor] });
  provider.register();
}

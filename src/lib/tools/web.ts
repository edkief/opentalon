import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { BraveSearch } from 'brave-search';
import { FreshnessOption } from 'brave-search/dist/types';
import { configManager } from '../config';

/** Serializes Brave web_search calls with 1s delay between completions (rate limit: 1 req/s). */
let webSearchQueue: Promise<boolean> = Promise.resolve(false);

const FRESHNESS_TO_DDGS: Record<string, string> = {
  pd: 'd',
  pw: 'w',
  pm: 'm',
  py: 'y',
};

export function getWebTools(): ToolSet {
  return {
    web_search: tool({
      description:
        'Search the web for current information. Use this when the user asks about ' +
        'recent events, facts, or anything that may require up-to-date information. ' +
        'By default results are limited to the past month — use freshness to widen ' +
        '(e.g. "py" for past year, or omit for all time) or tighten ("pw" past week, "pd" past day). ' +
        'Uses DDGS if tools.webSearch.ddgs.url is configured, otherwise falls back to Brave Search.',
      inputSchema: z.object({
        query: z.string().describe('The search query'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Number of results to return (default 5)'),
        freshness: z
          .enum(['pd', 'pw', 'pm', 'py'])
          .optional()
          .describe(
            'Limit results by discovery date: pd=past day, pw=past week, pm=past month (default), py=past year. ' +
            'Omit only for historical or timeless queries.',
          ),
      }),
      execute: async (input: { query: string; count?: number; freshness?: string }) => {
        const webSearch = configManager.get().tools?.webSearch;
        const ddgsUrl = webSearch?.ddgs?.url;
        const provider = webSearch?.provider ?? 'auto';
        const count = input.count ?? 5;

        const useDdgs = provider === 'ddgs' || (provider === 'auto' && !!ddgsUrl);
        const useBrave = provider === 'brave' || (provider === 'auto' && !ddgsUrl);

        if (useDdgs) {
          if (!ddgsUrl) return 'Web search is not configured (set tools.webSearch.ddgs.url in config.yaml).';
          try {
            const params = new URLSearchParams({ query: input.query, max_results: String(count) });
            if (input.freshness) params.set('timelimit', FRESHNESS_TO_DDGS[input.freshness] ?? input.freshness);
            const response = await fetch(`${ddgsUrl}/search/text?${params}`);
            if (!response.ok) return `Search failed: HTTP ${response.status}`;
            const data = await response.json() as { results: { title?: string; href?: string; body?: string }[] };
            if (!data.results?.length) return 'No results found.';
            return data.results
              .map((r, i) => `${i + 1}. **${r.title ?? ''}**\n   ${r.href ?? ''}\n   ${r.body ?? ''}`)
              .join('\n\n');
          } catch (err) {
            return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        if (useBrave) {
          const runSearch = async (): Promise<string> => {
            const apiKey = configManager.getSecrets().tools?.braveApiKey ?? process.env.BRAVE_API_KEY;
            if (!apiKey) return 'Web search is not configured (set tools.webSearch.ddgs.url in config.yaml, or tools.braveApiKey in secrets.yaml / BRAVE_API_KEY env var).';

            const client = new BraveSearch(apiKey);
            const freshness = (input.freshness ?? FreshnessOption.PastMonth) as FreshnessOption;

            try {
              const response = await client.webSearch(input.query, { count, freshness });
              const results = response.web?.results ?? [];
              if (results.length === 0) return 'No results found.';
              return results
                .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ''}`)
                .join('\n\n');
            } catch (err) {
              return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          };

          const myRun = webSearchQueue
            .then((prevStarted) =>
              prevStarted ? new Promise<void>((r) => setTimeout(r, 1000)) : undefined
            )
            .then(runSearch);
          webSearchQueue = myRun.then(() => true);
          return myRun;
        }

        return 'Web search is not configured.';
      },
    }),

    web_search_news: tool({
      description:
        'Search for recent news articles on a topic. Returns headlines, sources, dates, and summaries. ' +
        'Prefer this over web_search when the user explicitly asks for news, current events, or recent coverage. ' +
        'Requires tools.ddgs.url to be configured in config.yaml.',
      inputSchema: z.object({
        query: z.string().describe('The news search query'),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Number of articles to return (default 5)'),
        freshness: z
          .enum(['pd', 'pw', 'pm', 'py'])
          .optional()
          .describe(
            'Limit by publication date: pd=past day, pw=past week, pm=past month (default), py=past year.',
          ),
      }),
      execute: async (input: { query: string; count?: number; freshness?: string }) => {
        const ddgsUrl = configManager.get().tools?.webSearch?.ddgs?.url;
        if (!ddgsUrl) return 'News search is not configured (set tools.webSearch.ddgs.url in config.yaml).';

        try {
          const count = input.count ?? 5;
          const params = new URLSearchParams({ query: input.query, max_results: String(count) });
          if (input.freshness) params.set('timelimit', FRESHNESS_TO_DDGS[input.freshness] ?? input.freshness);
          const response = await fetch(`${ddgsUrl}/search/news?${params}`);
          if (!response.ok) return `News search failed: HTTP ${response.status}`;
          const data = await response.json() as { results: { title?: string; url?: string; body?: string; date?: string; source?: string }[] };
          if (!data.results?.length) return 'No news results found.';
          return data.results
            .map((r, i) =>
              `${i + 1}. **${r.title ?? ''}** · ${r.source ?? ''} · ${r.date ?? ''}\n   ${r.url ?? ''}\n   ${r.body ?? ''}`,
            )
            .join('\n\n');
        } catch (err) {
          return `News search failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    web_fetch: tool({
      description:
        'Fetch content from a URL. Returns the response body as text. ' +
        'Supports custom headers, HTTP methods, and request body. ' +
        'Use this to retrieve web page content, API responses, or any public URL content.',
      inputSchema: z.object({
        url: z.string().describe('The URL to fetch'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])
          .optional()
          .describe('HTTP method (default: GET)'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Custom headers as key-value pairs'),
        body: z
          .string()
          .optional()
          .describe('Request body for POST/PUT/PATCH methods'),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(60000)
          .optional()
          .describe('Request timeout in milliseconds (default: 30000)'),
      }),
      execute: async (input: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        timeout?: number;
      }) => {
        const controller = new AbortController();
        const timeout = input.timeout ?? 30_000;
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(input.url, {
            method: input.method ?? 'GET',
            headers: input.headers,
            body: input.body,
            signal: controller.signal,
          });

          const contentType = response.headers.get('content-type') ?? '';
          let data: string;

          if (contentType.includes('application/json')) {
            const json = await response.json();
            data = JSON.stringify(json, null, 2);
          } else {
            data = await response.text();
          }

          return `Status: ${response.status} ${response.statusText}\n` +
            `Content-Type: ${contentType}\n\n` +
            data;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return `Request timed out after ${timeout}ms`;
          }
          return `Fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          clearTimeout(timeoutId);
        }
      },
    }),
  };
}

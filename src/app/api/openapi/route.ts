import { NextResponse } from 'next/server';
import { configJsonSchema } from '@/lib/config/schema';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    openapi: '3.1.0',
    info: {
      title: 'OpenTalon Administrative API',
      version: '1.0.0',
      description: 'Live API documentation for safely inspecting and updating an OpenTalon instance.',
    },
    servers: [{ url: 'http://localhost:3000', description: 'Local OpenTalon instance' }],
    security: [{ bearerAuth: [] }, {}],
    paths: {
      '/api/config': {
        get: {
          summary: 'Read config.yaml and its validation state',
          responses: { '200': { description: 'Current configuration' }, '401': { description: 'Authentication required' } },
        },
        post: {
          summary: 'Validate or write the complete config.yaml document',
          description: 'Send validate_only=true before writing. A write replaces the complete document.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['content'],
                  properties: {
                    content: { type: 'string', description: 'Complete YAML document' },
                    validate_only: { type: 'boolean', default: false },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Validated or written' },
            '401': { description: 'Authentication required' },
            '422': { description: 'YAML or schema validation failed' },
          },
        },
      },
      '/api/config/schema': {
        get: {
          summary: 'Get the authoritative config or secrets JSON Schema',
          parameters: [{ name: 'file', in: 'query', schema: { type: 'string', enum: ['config', 'secrets'], default: 'config' } }],
          responses: { '200': { description: 'JSON Schema' }, '401': { description: 'Authentication required' } },
        },
      },
      '/api/config/snapshots': {
        get: {
          summary: 'List configuration snapshots',
          parameters: [{ name: 'file', in: 'query', schema: { type: 'string', enum: ['config', 'secrets'], default: 'config' } }],
          responses: { '200': { description: 'Snapshot list' }, '401': { description: 'Authentication required' } },
        },
        post: {
          summary: 'Create or restore a configuration snapshot',
          description: 'An empty body creates a snapshot. A body containing restore restores that filename.',
          parameters: [{ name: 'file', in: 'query', schema: { type: 'string', enum: ['config', 'secrets'], default: 'config' } }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: { restore: { type: 'string' } } } } },
          },
          responses: { '200': { description: 'Snapshot created or restored' }, '401': { description: 'Authentication required' }, '404': { description: 'Snapshot not found' } },
        },
      },
      '/api/config/status': {
        get: {
          summary: 'Read configuration health',
          security: [],
          responses: { '200': { description: 'Configuration status' } },
        },
      },
      '/api/services/status': {
        get: {
          summary: 'Read managed service status',
          responses: { '200': { description: 'Service status' }, '401': { description: 'Authentication required' } },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: { OpenTalonConfig: configJsonSchema },
    },
  });
}

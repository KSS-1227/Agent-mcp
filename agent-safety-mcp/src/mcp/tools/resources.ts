/**
 * Resource Management Tools - thin interface to ResourceService
 * 
 * Maps MCP tool inputs to ResourceService methods.
 * Supports resource registration, retrieval, and versioned updates.
 * No business logic here—all logic stays in ResourceService.
 */

import { ResourceService } from "../../core/resource.service";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getResourceServiceTools(service: ResourceService): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  // register_resource - Register a new resource with initial state
  tools.push({
    name: "register_resource",
    description: "Register a resource that agents may read or modify",
    inputSchema: {
      type: "object",
      properties: {
        resource_key: {
          type: "string",
          description: "External resource identifier (e.g., 'config:prod')",
        },
        resource_type: {
          type: "string",
          description: "Resource type (e.g., 'config', 'document', 'user')",
        },
        state: {
          type: "object",
          description: "Initial resource state/content",
        },
      },
      required: ["resource_key", "resource_type", "state"],
    },
    _handler: async (args: any) => {
      const resource = await service.registerResourcePersisted(
        args.resource_key,
        args.resource_type,
        args.state
      );

      // Return structured response with key fields
      return {
        id: resource.id,
        key: resource.key,
        type: resource.type,
        version: resource.version,
        state: resource.state,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
      };
    },
  });

  // get_resource - Retrieve resource by ID
  tools.push({
    name: "get_resource",
    description: "Retrieve a resource by its UUID",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: {
          type: "string",
          description: "Resource UUID",
        },
      },
      required: ["resource_id"],
    },
    _handler: async (args: any) => {
      const resource = service.getResource(args.resource_id);
      if (!resource) throw new Error(`Resource not found: ${args.resource_id}`);

      return {
        id: resource.id,
        key: resource.key,
        type: resource.type,
        version: resource.version,
        state: resource.state,
        createdAt: resource.createdAt,
        updatedAt: resource.updatedAt,
      };
    },
  });

  // list_resources - List resources, optionally filtered by type
  tools.push({
    name: "list_resources",
    description: "List resources, optionally filtered by type",
    inputSchema: {
      type: "object",
      properties: {
        resource_type: {
          type: "string",
          description: "Filter by resource type (optional)",
        },
      },
      required: [],
    },
    _handler: async (args: any) => {
      const resources = args.resource_type
        ? service.listResourcesByType(args.resource_type)
        : service.listResources();

      return {
        resources: resources.map((r) => ({
          id: r.id,
          key: r.key,
          type: r.type,
          version: r.version,
          state: r.state,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
      };
    },
  });

  // update_resource - Update resource state with optimistic version checking
  tools.push({
    name: "update_resource",
    description: "Update resource state with optimistic version checking",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: {
          type: "string",
          description: "Resource UUID",
        },
        new_state: {
          type: "object",
          description: "New resource state",
        },
        expected_version: {
          type: "number",
          description: "Optional: only update if current version matches (optimistic lock)",
        },
      },
      required: ["resource_id", "new_state"],
    },
    _handler: async (args: any) => {
      const result = await service.updateResourcePersisted(
        args.resource_id,
        args.new_state,
        args.expected_version
      );

      if (!result) {
        return {
          error: "Version mismatch or resource not found",
          resource_id: args.resource_id,
          expected_version: args.expected_version,
        };
      }

      return {
        id: result.id,
        key: result.key,
        type: result.type,
        version: result.version,
        state: result.state,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };
    },
  });

  return tools;
}



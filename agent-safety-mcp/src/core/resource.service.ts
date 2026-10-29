/**
 * Resource Service - Unified resource management for Anchor and Interlock
 *
 * Resources are versioned shared state. Every write increments the version,
 * enabling both systems to detect conflicts:
 * - Anchor uses version checks for exactly-once semantics
 * - Interlock uses version reads to detect what changed
 */

import { v4 as uuidv4 } from "uuid";
import { Resource } from "./types";
import { DatabaseClient } from "../database/client";

export class ResourceService {
  private resources = new Map<string, Resource>();
  private keyIndex = new Map<string, string>(); // key -> id mapping
  private db: DatabaseClient | null = null;

  constructor(db?: DatabaseClient) {
    this.db = db || null;
  }

  setDatabase(db: DatabaseClient): void {
    this.db = db;
  }

  async loadFromDatabase(): Promise<void> {
    if (!this.db) return;

    const result = await this.db.query(
      `SELECT id, resource_key, resource_type, version, state, created_at, updated_at
         FROM resources
        ORDER BY created_at, id`
    );

    this.resources.clear();
    this.keyIndex.clear();
    for (const row of result.rows) {
      const resource: Resource = {
        id: row.id,
        key: row.resource_key,
        type: row.resource_type,
        version: row.version,
        state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      };
      this.resources.set(resource.id, resource);
      if (!this.keyIndex.has(resource.key)) {
        this.keyIndex.set(resource.key, resource.id);
      }
    }
  }

  async registerResourcePersisted(
    resourceKey: string,
    type: string,
    state: Record<string, any>
  ): Promise<Resource> {
    if (!this.db) return this.registerResource(resourceKey, type, state);

    const resource = await this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [resourceKey]);
      const existing = await tx.query(
        `SELECT id, resource_key, resource_type, version, state, created_at, updated_at
           FROM resources
          WHERE resource_key = $1
          ORDER BY created_at, id
          LIMIT 1`,
        [resourceKey]
      );
      if (existing.rows.length > 0) {
        return this.mapResourceRow(existing.rows[0]);
      }

      const inserted = await tx.query(
        `INSERT INTO resources (resource_key, resource_type, version, state)
         VALUES ($1, $2, 1, $3)
         RETURNING id, resource_key, resource_type, version, state, created_at, updated_at`,
        [resourceKey, type, JSON.stringify(state)]
      );
      return this.mapResourceRow(inserted.rows[0]);
    });

    this.storeResource(resource);
    return resource;
  }

  async updateResourcePersisted(
    resourceId: string,
    newState: Record<string, any>,
    expectedVersion?: number
  ): Promise<Resource | undefined> {
    if (!this.db) return this.updateResource(resourceId, newState, expectedVersion);

    const currentResult = await this.db.query(
      `SELECT id, resource_key, resource_type, version, state, created_at, updated_at
         FROM resources
        WHERE id = $1`,
      [resourceId]
    );
    if (currentResult.rows.length === 0) return undefined;

    const current = this.mapResourceRow(currentResult.rows[0]);
    const version = expectedVersion ?? current.version;
    if (current.version !== version) return undefined;

    const updatedResult = await this.db.query(
      `UPDATE resources
          SET state = $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $3
        RETURNING id, resource_key, resource_type, version, state, created_at, updated_at`,
      [resourceId, JSON.stringify(newState), version]
    );
    if (updatedResult.rows.length === 0) return undefined;

    const updated = this.mapResourceRow(updatedResult.rows[0]);
    this.storeResource(updated);
    return updated;
  }

  private mapResourceRow(row: any): Resource {
    return {
      id: row.id,
      key: row.resource_key,
      type: row.resource_type,
      version: row.version,
      state: typeof row.state === "string" ? JSON.parse(row.state) : row.state,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private storeResource(resource: Resource): void {
    this.resources.set(resource.id, resource);
    this.keyIndex.set(resource.key, resource.id);
  }

  /**
   * Register a new resource in the system.
   * Returns the created resource with version 1.
   */
  registerResource(
    resourceKey: string,
    type: string,
    state: Record<string, any>
  ): Resource {
    // Check if resource already exists
    const existingId = this.keyIndex.get(resourceKey);
    if (existingId) {
      const existing = this.resources.get(existingId);
      if (existing) return existing;
    }

    const id = uuidv4();
    const now = new Date();
    const resource: Resource = {
      id,
      key: resourceKey,
      type,
      version: 1,
      state,
      createdAt: now,
      updatedAt: now,
    };

    this.resources.set(id, resource);
    this.keyIndex.set(resourceKey, id);

    return resource;
  }

  /**
   * Get a resource by UUID.
   */
  getResource(resourceId: string): Resource | undefined {
    return this.resources.get(resourceId);
  }

  /**
   * Get a resource by external key.
   */
  getResourceByKey(resourceKey: string): Resource | undefined {
    const id = this.keyIndex.get(resourceKey);
    return id ? this.resources.get(id) : undefined;
  }

  /**
   * Update a resource with new state.
   * Increments version automatically.
   * 
   * @param resourceId - UUID of the resource
   * @param newState - New state object
   * @param expectedVersion - If provided, only updates if current version matches
   * @returns Updated resource, or undefined if not found or version mismatch
   */
  updateResource(
    resourceId: string,
    newState: Record<string, any>,
    expectedVersion?: number
  ): Resource | undefined {
    const resource = this.resources.get(resourceId);
    if (!resource) return undefined;

    // Version check for optimistic concurrency
    if (expectedVersion !== undefined && resource.version !== expectedVersion) {
      return undefined; // Version mismatch, update failed
    }

    const updated: Resource = {
      ...resource,
      version: resource.version + 1,
      state: newState,
      updatedAt: new Date(),
    };

    this.resources.set(resourceId, updated);
    return updated;
  }

  /**
   * List all resources.
   */
  listResources(): Resource[] {
    return Array.from(this.resources.values());
  }

  /**
   * List resources of a specific type.
   */
  listResourcesByType(type: string): Resource[] {
    return Array.from(this.resources.values()).filter((r) => r.type === type);
  }

  /**
   * Get version of a resource (for reads).
   */
  getVersion(resourceId: string): number | undefined {
    return this.resources.get(resourceId)?.version;
  }

  /**
   * Clear all resources (for testing).
   */
  clear(): void {
    this.resources.clear();
    this.keyIndex.clear();
  }
}

// Singleton instance
let resourceService: ResourceService | null = null;

export function getResourceService(): ResourceService {
  if (!resourceService) {
    resourceService = new ResourceService();
  }
  return resourceService;
}

export function setResourceService(service: ResourceService): void {
  resourceService = service;
}

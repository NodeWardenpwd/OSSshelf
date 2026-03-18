/**
 * services/bucket.service.ts
 * 存储桶服务层
 *
 * 功能:
 * - 存储桶CRUD操作封装
 * - 凭证加密管理
 * - 连接测试
 * - 配额管理
 */

import { eq, and } from 'drizzle-orm';
import { getDb, storageBuckets } from '../db';
import { makeBucketConfigAsync, testS3Connection, encryptSecret } from '../lib/s3client';
import { getEncryptionKey } from '../lib/crypto';
import type { Env } from '../types/env';

type DbType = ReturnType<typeof getDb>;

export interface BucketCreateParams {
  userId: string;
  name: string;
  provider: string;
  bucketName: string;
  endpoint?: string | null;
  region?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle?: boolean;
  isDefault?: boolean;
  storageQuota?: number | null;
  notes?: string | null;
}

export interface BucketUpdateParams {
  name?: string;
  provider?: string;
  bucketName?: string;
  endpoint?: string | null;
  region?: string | null;
  accessKeyId?: string;
  secretAccessKey?: string;
  pathStyle?: boolean;
  isDefault?: boolean;
  storageQuota?: number | null;
  notes?: string | null;
}

export class BucketService {
  private db: DbType;
  private encKey: string;

  constructor(env: Env) {
    this.db = getDb(env.DB);
    this.encKey = getEncryptionKey(env);
  }

  async findById(bucketId: string, userId: string) {
    return this.db
      .select()
      .from(storageBuckets)
      .where(and(eq(storageBuckets.id, bucketId), eq(storageBuckets.userId, userId)))
      .get();
  }

  async findByUserId(userId: string, activeOnly = true) {
    const conditions = [eq(storageBuckets.userId, userId)];
    if (activeOnly) {
      conditions.push(eq(storageBuckets.isActive, true));
    }

    return this.db.select().from(storageBuckets).where(and(...conditions)).all();
  }

  async findDefault(userId: string) {
    return this.db
      .select()
      .from(storageBuckets)
      .where(and(eq(storageBuckets.userId, userId), eq(storageBuckets.isDefault, true), eq(storageBuckets.isActive, true)))
      .get();
  }

  async create(params: BucketCreateParams) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    if (params.isDefault) {
      await this.clearDefaultFlag(params.userId);
    }

    const existing = await this.findByUserId(params.userId);
    const shouldBeDefault = params.isDefault || existing.length === 0;

    const encryptedAccessKeyId = await encryptSecret(params.accessKeyId, this.encKey);
    const encryptedSecretAccessKey = await encryptSecret(params.secretAccessKey, this.encKey);

    const [newBucket] = await this.db
      .insert(storageBuckets)
      .values({
        id,
        userId: params.userId,
        name: params.name,
        provider: params.provider,
        bucketName: params.bucketName,
        endpoint: params.endpoint ?? null,
        region: params.region ?? null,
        accessKeyId: encryptedAccessKeyId,
        secretAccessKey: encryptedSecretAccessKey,
        pathStyle: params.pathStyle ?? false,
        isDefault: shouldBeDefault,
        isActive: true,
        storageUsed: 0,
        fileCount: 0,
        storageQuota: params.storageQuota ?? null,
        notes: params.notes ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return newBucket;
  }

  async update(bucketId: string, userId: string, params: BucketUpdateParams) {
    const now = new Date().toISOString();
    const bucket = await this.findById(bucketId, userId);

    if (!bucket) return null;

    if (params.isDefault && !bucket.isDefault) {
      await this.clearDefaultFlag(userId);
    }

    const updateData: Record<string, unknown> = { updatedAt: now };

    if (params.name !== undefined) updateData.name = params.name;
    if (params.provider !== undefined) updateData.provider = params.provider;
    if (params.bucketName !== undefined) updateData.bucketName = params.bucketName;
    if (params.endpoint !== undefined) updateData.endpoint = params.endpoint || null;
    if (params.region !== undefined) updateData.region = params.region || null;
    if (params.accessKeyId !== undefined) {
      updateData.accessKeyId = await encryptSecret(params.accessKeyId, this.encKey);
    }
    if (params.secretAccessKey !== undefined) {
      updateData.secretAccessKey = await encryptSecret(params.secretAccessKey, this.encKey);
    }
    if (params.pathStyle !== undefined) updateData.pathStyle = params.pathStyle;
    if (params.isDefault !== undefined) updateData.isDefault = params.isDefault;
    if (params.storageQuota !== undefined) updateData.storageQuota = params.storageQuota ?? null;
    if (params.notes !== undefined) updateData.notes = params.notes || null;

    const [updated] = await this.db
      .update(storageBuckets)
      .set(updateData)
      .where(eq(storageBuckets.id, bucketId))
      .returning();

    return updated;
  }

  async delete(bucketId: string, userId: string) {
    await this.db.delete(storageBuckets).where(and(eq(storageBuckets.id, bucketId), eq(storageBuckets.userId, userId)));
  }

  async testConnection(bucketId: string, userId: string) {
    const bucket = await this.findById(bucketId, userId);
    if (!bucket) {
      return { success: false, error: '存储桶不存在' };
    }

    try {
      const config = await makeBucketConfigAsync(bucket, this.encKey, this.db);
      const result = await testS3Connection(config);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  async setDefault(bucketId: string, userId: string) {
    await this.clearDefaultFlag(userId);

    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(storageBuckets)
      .set({ isDefault: true, updatedAt: now })
      .where(and(eq(storageBuckets.id, bucketId), eq(storageBuckets.userId, userId)))
      .returning();

    return updated;
  }

  async getStats(userId: string) {
    const buckets = await this.findByUserId(userId);

    return {
      totalBuckets: buckets.length,
      activeBuckets: buckets.filter((b) => b.isActive).length,
      totalStorageUsed: buckets.reduce((sum, b) => sum + (b.storageUsed ?? 0), 0),
      totalFileCount: buckets.reduce((sum, b) => sum + (b.fileCount ?? 0), 0),
    };
  }

  private async clearDefaultFlag(userId: string) {
    const now = new Date().toISOString();
    await this.db
      .update(storageBuckets)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(storageBuckets.userId, userId), eq(storageBuckets.isDefault, true)));
  }
}

export function createBucketService(env: Env): BucketService {
  return new BucketService(env);
}

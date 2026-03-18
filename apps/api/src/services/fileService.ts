/**
 * services/file.service.ts
 * 文件服务层
 *
 * 功能:
 * - 文件CRUD操作封装
 * - 存储配额检查
 * - 文件权限验证
 * - 存储桶解析
 */

import { eq, and, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { getDb, files, users, storageBuckets } from '../db';
import { resolveBucketConfig, updateBucketStats, checkBucketQuota } from '../lib/bucketResolver';
import { s3Put, s3Get, s3Delete } from '../lib/s3client';
import { getEncryptionKey } from '../lib/crypto';
import type { Env } from '../types/env';

type DbType = ReturnType<typeof getDb>;

export interface FileCreateParams {
  userId: string;
  name: string;
  parentId: string | null;
  isFolder: boolean;
  size?: number;
  mimeType?: string | null;
  r2Key?: string;
  bucketId?: string | null;
  hash?: string | null;
}

export interface FileUpdateParams {
  name?: string;
  parentId?: string | null;
  mimeType?: string | null;
  size?: number;
  hash?: string | null;
}

export interface FileListParams {
  userId: string;
  parentId: string | null;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export class FileService {
  private db: DbType;
  private encKey: string;

  constructor(env: Env) {
    this.db = getDb(env.DB);
    this.encKey = getEncryptionKey(env);
  }

  async findById(fileId: string, userId: string) {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .get();
  }

  async findByIdWithDeleted(fileId: string, userId: string) {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, userId)))
      .get();
  }

  async list(params: FileListParams) {
    const { userId, parentId, includeDeleted = false, limit = 100, offset = 0 } = params;

    const conditions = [eq(files.userId, userId)];
    if (parentId === null) {
      conditions.push(isNull(files.parentId));
    } else {
      conditions.push(eq(files.parentId, parentId));
    }
    if (!includeDeleted) {
      conditions.push(isNull(files.deletedAt));
    }

    return this.db
      .select()
      .from(files)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .all();
  }

  async create(params: FileCreateParams) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    const path = await this.buildPath(params.parentId, params.name);

    const [newFile] = await this.db
      .insert(files)
      .values({
        id,
        userId: params.userId,
        name: params.name,
        parentId: params.parentId,
        path,
        type: params.isFolder ? 'folder' : 'file',
        size: params.size ?? 0,
        r2Key: params.r2Key ?? `files/${params.userId}/${id}/${params.name}`,
        mimeType: params.mimeType ?? null,
        hash: params.hash ?? null,
        isFolder: params.isFolder,
        bucketId: params.bucketId ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      })
      .returning();

    return newFile;
  }

  async update(fileId: string, userId: string, params: FileUpdateParams) {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updatedAt: now };

    if (params.name !== undefined) updateData.name = params.name;
    if (params.parentId !== undefined) {
      updateData.parentId = params.parentId;
      if (params.name) {
        updateData.path = await this.buildPath(params.parentId, params.name);
      }
    }
    if (params.mimeType !== undefined) updateData.mimeType = params.mimeType;
    if (params.size !== undefined) updateData.size = params.size;
    if (params.hash !== undefined) updateData.hash = params.hash;

    const [updated] = await this.db
      .update(files)
      .set(updateData)
      .where(and(eq(files.id, fileId), eq(files.userId, userId)))
      .returning();

    return updated;
  }

  async softDelete(fileId: string, userId: string) {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(files)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNull(files.deletedAt)))
      .returning();

    return updated;
  }

  async permanentDelete(fileId: string, userId: string) {
    await this.db.delete(files).where(and(eq(files.id, fileId), eq(files.userId, userId)));
  }

  async restore(fileId: string, userId: string) {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(files)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(eq(files.id, fileId), eq(files.userId, userId), isNotNull(files.deletedAt)))
      .returning();

    return updated;
  }

  async getStats(userId: string) {
    const [activeStats] = await this.db
      .select({
        fileCount: sql<number>`sum(case when ${files.isFolder} = 0 then 1 else 0 end)`,
        folderCount: sql<number>`sum(case when ${files.isFolder} = 1 then 1 else 0 end)`,
        totalSize: sql<number>`sum(${files.size})`,
      })
      .from(files)
      .where(and(eq(files.userId, userId), isNull(files.deletedAt)));

    const [trashStats] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(files)
      .where(and(eq(files.userId, userId), isNotNull(files.deletedAt)));

    return {
      fileCount: Number(activeStats?.fileCount ?? 0),
      folderCount: Number(activeStats?.folderCount ?? 0),
      trashCount: Number(trashStats?.count ?? 0),
      totalSize: Number(activeStats?.totalSize ?? 0),
    };
  }

  async checkUserQuota(userId: string, additionalBytes: number): Promise<{ allowed: boolean; message?: string }> {
    const user = await this.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) return { allowed: false, message: '用户不存在' };

    if (user.storageUsed + additionalBytes > user.storageQuota) {
      return { allowed: false, message: '存储配额不足' };
    }

    return { allowed: true };
  }

  async resolveBucket(userId: string, bucketId: string | null, parentId?: string | null) {
    return resolveBucketConfig(this.db, userId, this.encKey, bucketId, parentId);
  }

  private async buildPath(parentId: string | null, name: string): Promise<string> {
    if (!parentId) return `/${name}`;

    const parent = await this.db
      .select({ path: files.path })
      .from(files)
      .where(eq(files.id, parentId))
      .get();

    return parent ? `${parent.path}/${name}` : `/${name}`;
  }
}

export function createFileService(env: Env): FileService {
  return new FileService(env);
}

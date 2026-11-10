import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  desktopComputerPairings,
  desktopPairingInstallation,
  revokedAccess,
  userRoles,
  users,
} from "../db/schema";

export type DurablePairing = {
  bindingId: string;
  computerId: string;
  ownerUserId: string;
  installationId: string;
  name: string;
};
type ActivatePairing = (pairing: DurablePairing) => void | Promise<void>;
export interface DesktopPairingStore {
  audience(): Promise<string>;
  ownerAllowed(ownerUserId: string): Promise<boolean>;
  issue(
    ownerUserId: string,
    installationId: string,
    computer: { computerId: string; name: string },
    activate?: ActivatePairing,
  ): Promise<{ pairing: DurablePairing; voucher: string }>;
  reconnect(
    installationId: string,
    bindingId: string,
    computerId: string,
    voucher: string,
    activate?: ActivatePairing,
  ): Promise<DurablePairing | null>;
  owned(
    ownerUserId: string,
    installationId: string,
    computerId: string,
  ): Promise<DurablePairing | null>;
  revoke(
    installationId: string,
    bindingId: string,
    computerId: string,
    ownerUserId: string,
  ): Promise<boolean>;
  revokeOwner(ownerUserId: string): Promise<void>;
}
export class DesktopPairingRefusedError extends Error {
  constructor() {
    super(
      "That workspace connection is unavailable. Pair it again from Computers.",
    );
  }
}
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const project = (
  row: typeof desktopComputerPairings.$inferSelect,
): DurablePairing => ({
  bindingId: row.id,
  computerId: row.computerId,
  ownerUserId: row.ownerUserId,
  installationId: row.installationId,
  name: row.name,
});

export function createDesktopPairingStore(
  database: Database,
  options: { singleUserOwnerId?: string } = {},
): DesktopPairingStore {
  const ownerAllowedFor = async (
    reader: Pick<Database, "select">,
    id: string,
  ) => {
    const [person] = await reader
      .select({ id: users.id })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(
        revokedAccess,
        eq(revokedAccess.email, sql`lower(trim(${users.email}))`),
      )
      .where(
        and(
          eq(users.id, id),
          isNull(revokedAccess.email),
          options.singleUserOwnerId
            ? or(
                inArray(userRoles.role, ["user", "admin"]),
                eq(users.id, options.singleUserOwnerId),
              )
            : inArray(userRoles.role, ["user", "admin"]),
        ),
      )
      .limit(1);
    return !!person;
  };
  const ownerAllowed = (id: string) => ownerAllowedFor(database, id);
  return {
    async audience() {
      await database
        .insert(desktopPairingInstallation)
        .values({ id: "current", audience: randomUUID() })
        .onConflictDoNothing();
      const [row] = await database
        .select()
        .from(desktopPairingInstallation)
        .where(eq(desktopPairingInstallation.id, "current"))
        .limit(1);
      if (!row) throw new DesktopPairingRefusedError();
      return row.audience;
    },
    ownerAllowed,
    async issue(ownerUserId, installationId, computer, activate) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`desktop-pair-owner:${ownerUserId}`}, 0))`,
        );
        if (!(await ownerAllowedFor(tx, ownerUserId)))
          throw new DesktopPairingRefusedError();
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`desktop-pair:${installationId}:${computer.computerId}`}, 0))`,
        );
        const [current] = await tx
          .select()
          .from(desktopComputerPairings)
          .where(
            and(
              eq(desktopComputerPairings.installationId, installationId),
              eq(desktopComputerPairings.computerId, computer.computerId),
            ),
          )
          .for("update");
        if (
          current &&
          !current.revokedAt &&
          current.ownerUserId !== ownerUserId
        )
          throw new DesktopPairingRefusedError();
        const voucher = randomBytes(32).toString("hex");
        const values = {
          id: randomUUID(),
          installationId,
          computerId: computer.computerId,
          ownerUserId,
          name: computer.name,
          secretHash: hash(voucher),
          revokedAt: null,
          updatedAt: new Date(),
        };
        const [row] = await tx
          .insert(desktopComputerPairings)
          .values(values)
          .onConflictDoUpdate({
            target: [
              desktopComputerPairings.installationId,
              desktopComputerPairings.computerId,
            ],
            set: values,
          })
          .returning();
        if (!row) throw new DesktopPairingRefusedError();
        const pairing = project(row);
        await activate?.(pairing);
        return { pairing, voucher };
      });
    },
    async reconnect(installationId, bindingId, computerId, voucher, activate) {
      if (!/^[a-f0-9]{64}$/.test(voucher)) return null;
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`desktop-pair:${installationId}:${computerId}`}, 0))`,
        );
        const [row] = await tx
          .select()
          .from(desktopComputerPairings)
          .where(
            and(
              eq(desktopComputerPairings.id, bindingId),
              eq(desktopComputerPairings.installationId, installationId),
              eq(desktopComputerPairings.computerId, computerId),
              isNull(desktopComputerPairings.revokedAt),
            ),
          )
          .for("update");
        if (
          !row ||
          !/^[a-f0-9]{64}$/.test(row.secretHash) ||
          !timingSafeEqual(
            Buffer.from(row.secretHash, "hex"),
            Buffer.from(hash(voucher), "hex"),
          ) ||
          !(await ownerAllowedFor(tx, row.ownerUserId))
        )
          return null;
        const pairing = project(row);
        await activate?.(pairing);
        return pairing;
      });
    },
    async owned(ownerUserId, installationId, computerId) {
      if (!(await ownerAllowed(ownerUserId))) return null;
      const [row] = await database
        .select()
        .from(desktopComputerPairings)
        .where(
          and(
            eq(desktopComputerPairings.ownerUserId, ownerUserId),
            eq(desktopComputerPairings.installationId, installationId),
            eq(desktopComputerPairings.computerId, computerId),
            isNull(desktopComputerPairings.revokedAt),
          ),
        )
        .limit(1);
      return row ? project(row) : null;
    },
    async revoke(installationId, bindingId, computerId, ownerUserId) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`desktop-pair:${installationId}:${computerId}`}, 0))`,
        );
        const rows = await tx
          .update(desktopComputerPairings)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(desktopComputerPairings.id, bindingId),
              eq(desktopComputerPairings.installationId, installationId),
              eq(desktopComputerPairings.computerId, computerId),
              eq(desktopComputerPairings.ownerUserId, ownerUserId),
            ),
          )
          .returning({ id: desktopComputerPairings.id });
        return rows.length === 1;
      });
    },
    async revokeOwner(ownerUserId) {
      await database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`desktop-pair-owner:${ownerUserId}`}, 0))`,
        );
        await tx
          .update(desktopComputerPairings)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(eq(desktopComputerPairings.ownerUserId, ownerUserId));
      });
    },
  };
}

import { z } from "zod";
import { exactOrganisationQuantitySchema as quantity, organisationLimitSchema as limit, organisationTimeZoneSchema } from "./organisation.js";
export const organisationWeekSchema = z.object({
  id: z.uuid(), organisationId: z.uuid(), timeZone: organisationTimeZoneSchema,
  startsAt: z.iso.datetime(), endsAt: z.iso.datetime(),
}).refine(value => value.endsAt > value.startsAt, "Period end must follow its start");
export const organisationWeeklyPolicySchema = z.object({
  defaultEmployeeSpend: limit,
  timeZone: organisationTimeZoneSchema,
  pendingTimeZone: organisationTimeZoneSchema.nullable(),
});
export const employeeAllowanceOverrideSchema = z.discriminatedUnion("duration", [
  z.object({ duration: z.literal("permanent"), spend: limit }).strict(),
  z.object({ duration: z.literal("current_week"), periodId: z.uuid(), spend: limit }).strict(),
]);
export const employeeAllowanceSchema = z.object({
  userId: z.uuid(), period: organisationWeekSchema,
  limit, used: quantity, available: limit,
  source: z.enum(["organisation_default", "permanent", "current_week"]),
  permanentOverride: z.object({ spend: limit }).nullable(),
  currentWeekOverride: z.object({ spend: limit }).nullable(),
});
export const organisationCapacityPayerSchema = z.object({
  organisationId: z.uuid(),
  ownershipVersion: quantity.nullable(),
  chargedSubject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("employee"), userId: z.uuid() }).strict(),
    z.object({ kind: z.literal("automation"), appId: z.uuid() }).strict(),
    z.object({ kind: z.literal("organisation") }).strict(),
  ]),
});
export const organisationWeeklyCapacitySchema = z.object({
  period: organisationWeekSchema,
  policy: organisationWeeklyPolicySchema,
  employees: z.array(employeeAllowanceSchema),
});
export type OrganisationWeek = z.infer<typeof organisationWeekSchema>;
export type OrganisationCapacityPayer = z.infer<typeof organisationCapacityPayerSchema>;

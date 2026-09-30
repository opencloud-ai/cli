import { z } from "zod";
const people = z.array(z.uuid()).max(1000).refine(value => new Set(value).size === value.length, "Select each person once");
const privateAudience = z.object({ mode: z.literal("private") }).strict();
const selectedAudience = z.object({ mode: z.literal("people"), userIds: people }).strict();
const organisationAudience = z.object({ mode: z.literal("organisation") }).strict();
export const appUseAudienceSchema = z.discriminatedUnion("mode", [
  privateAudience, selectedAudience, organisationAudience, z.object({ mode: z.literal("public") }).strict(),
]);
export const appAdminAudienceSchema = z.discriminatedUnion("mode", [
  privateAudience, selectedAudience, organisationAudience,
]);
export const appAudiencesSchema = z.object({
  use: appUseAudienceSchema,
  admin: appAdminAudienceSchema,
}).strict();
export type AppAudiences = z.infer<typeof appAudiencesSchema>;
export const appSharingViewSchema = appAudiencesSchema.extend({
  appId: z.uuid(), organisationId: z.uuid(), organisationWideAllowed: z.boolean(),
  people: z.array(z.object({ userId: z.uuid(), email: z.email(), displayName: z.string().nullable() })),
  governanceDisclosure: z.string(),
});

// src/modules/fragments/server/procedures.ts
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";
import { TRPCError } from "@trpc/server";
import z from "zod";
import { getOrRecreateSandbox, closeSandbox } from "@/lib/sandbox-manager";
import prisma from "@/lib/db";

export const fragmentsRouter = createTRPCRouter({
  /**
   * Get or recreate sandbox for a fragment
   */
  getOrRecreateSandbox: protectedProcedure
    .input(
      z.object({
        fragmentId: z.string().min(1, { message: "Fragment ID is required" })
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        // Verify user has access to this fragment
        const fragment = await prisma.fragment.findUnique({
          where: { id: input.fragmentId },
          include: {
            message: {
              include: {
                project: true
              }
            }
          }
        });

        if (!fragment) {
          throw new TRPCError({ 
            code: "NOT_FOUND", 
            message: "Fragment not found" 
          });
        }

        if (fragment.message.project.userId !== ctx.auth.userId) {
          throw new TRPCError({ 
            code: "FORBIDDEN", 
            message: "You don't have access to this fragment" 
          });
        }

        // Get or recreate sandbox
        const result = await getOrRecreateSandbox(input.fragmentId);

        // Close sandbox after returning URL (it will stay alive due to timeout)
        // We don't await this to return faster
        closeSandbox(result.sandbox).catch(console.error);

        return {
          url: result.url,
          isNew: result.isNew,
          message: result.isNew 
            ? "Sandbox was recreated with your saved files" 
            : "Connected to existing sandbox"
        };
      } catch (error) {
        console.error("[getOrRecreateSandbox] Error:", error);
        
        if (error instanceof TRPCError) {
          throw error;
        }
        
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to get or recreate sandbox"
        });
      }
    }),

  /**
   * Get fragment details
   */
  getOne: protectedProcedure
    .input(
      z.object({
        fragmentId: z.string().min(1, { message: "Fragment ID is required" })
      })
    )
    .query(async ({ input, ctx }) => {
      const fragment = await prisma.fragment.findUnique({
        where: { id: input.fragmentId },
        include: {
          message: {
            include: {
              project: true
            }
          }
        }
      });

      if (!fragment) {
        throw new TRPCError({ 
          code: "NOT_FOUND", 
          message: "Fragment not found" 
        });
      }

      if (fragment.message.project.userId !== ctx.auth.userId) {
        throw new TRPCError({ 
          code: "FORBIDDEN", 
          message: "You don't have access to this fragment" 
        });
      }

      return fragment;
    })
});
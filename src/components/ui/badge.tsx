import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        outline: "bg-card text-muted-foreground",
        primary: "border-transparent bg-primary text-primary-foreground",
        future: "border-transparent bg-nov-future/12 text-nov-future",
        high: "border-transparent bg-nov-high/12 text-nov-high",
        likely: "border-transparent bg-nov-likely/16 text-[#8a6700]",
        low: "border-transparent bg-nov-low/18 text-[#5b6168]",
        contacted: "border-transparent bg-contacted/12 text-contacted",
        danger: "border-transparent bg-destructive/10 text-destructive",
        warning: "border-transparent bg-nov-likely/16 text-[#8a6700]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

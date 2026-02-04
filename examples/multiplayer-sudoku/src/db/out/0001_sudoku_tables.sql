-- Drop old tables that we don't need anymore
DROP TABLE IF EXISTS "todos";
DROP TABLE IF EXISTS "projects";

-- Drop old triggers and functions
DROP TRIGGER IF EXISTS sync_todo_user_ids_trigger ON projects;
DROP TRIGGER IF EXISTS populate_todo_user_ids_trigger ON todos;
DROP FUNCTION IF EXISTS sync_todo_user_ids();
DROP FUNCTION IF EXISTS populate_todo_user_ids();

-- Create sudoku_cells table (approximately 9,963 rows for 123 puzzles)
CREATE TABLE "sudoku_cells" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sudoku_cells_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"puzzle_id" smallint NOT NULL,
	"row" smallint NOT NULL,
	"col" smallint NOT NULL,
	"value" smallint,
	"is_given" boolean DEFAULT false NOT NULL,
	"filled_by" text,
	"filled_by_name" varchar(255),
	"filled_by_color" varchar(7),
	"filled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "game_state" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "game_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"total_cells" integer DEFAULT 9963 NOT NULL,
	"filled_cells" integer DEFAULT 0 NOT NULL,
	"given_cells" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "player_stats_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"cells_filled" integer DEFAULT 0 NOT NULL,
	"correct_cells" integer DEFAULT 0 NOT NULL,
	"color" varchar(7) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_stats_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "sudoku_cells" ADD CONSTRAINT "sudoku_cells_filled_by_users_id_fk" FOREIGN KEY ("filled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Create index for faster lookups
CREATE INDEX "sudoku_cells_puzzle_id_idx" ON "sudoku_cells" ("puzzle_id");
CREATE INDEX "sudoku_cells_filled_by_idx" ON "sudoku_cells" ("filled_by") WHERE "filled_by" IS NOT NULL;

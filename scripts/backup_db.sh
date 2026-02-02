#!/bin/bash

# Load environment variables if present
if [ -f .env ]; then
  echo "📄 Loading from .env..."
  set -a
  source .env
  set +a
elif [ -f backend/.env ]; then
  echo "📄 Loading from backend/.env..."
  set -a
  source backend/.env
  set +a
fi

# Configuration
BACKUP_DIR="db/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
SCHEMA_FILE="$BACKUP_DIR/schema.sql"
DATA_FILE="$BACKUP_DIR/data_$TIMESTAMP.sql"
FULL_FILE="$BACKUP_DIR/full_backup_$TIMESTAMP.sql"

# Check for required tools
if ! command -v pg_dump &> /dev/null; then
    echo "❌ PostgreSQL tools (pg_dump) could not be found. Please install postgresql-client."
    exit 1
fi

# Check for connection variables
if [ -z "$PGHOST" ] || [ -z "$PGPASSWORD" ]; then
    echo "⚠️  Missing PGHOST or PGPASSWORD environment variables."
    echo "   Please set them in your shell or .env file:"
    echo "   export PGHOST=db.projectref.supabase.co"
    echo "   export PGPORT=5432"
    echo "   export PGDATABASE=postgres"
    echo "   export PGUSER=postgres"
    echo "   export PGPASSWORD=your-db-password"
    exit 1
fi

echo "🚀 Starting backup process..."
echo "   Host: $PGHOST"
echo "   Target: $BACKUP_DIR"

# 1. Schema Backup (Always overwrite schema.sql for version control)
echo -n "📦 Dumping schema (structural)... "
pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --file "$SCHEMA_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Done ($SCHEMA_FILE)"
else
    echo "❌ Failed"
    exit 1
fi

# 2. Data Backup (Timestamped, ignored by git)
echo -n "💾 Dumping data (rows)... "
pg_dump \
  --data-only \
  --disable-triggers \
  --file "$DATA_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Done ($DATA_FILE)"
else
    echo "❌ Failed"
    exit 1
fi

echo ""
echo "🎉 Backup complete!"
echo "   - Schema: $SCHEMA_FILE (Commit this!)"
echo "   - Data:   $DATA_FILE (Keep safe, do not commit)"

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// Initial setup to load environment variables
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Load from backend/.env
dotenv.config({ path: path.resolve(__dirname, '../.env') })

async function runTest() {
    console.log('🔒 Starting RLS Policy Test...\n')

    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseKey = process.env.SUPABASE_KEY
    const testEmail = process.env.TEST_EMAIL
    const testPassword = process.env.TEST_PASSWORD

    // Check configuration
    const missingVars = []
    if (!supabaseUrl) missingVars.push('SUPABASE_URL')
    if (!supabaseKey) missingVars.push('SUPABASE_KEY')
    if (!testEmail) missingVars.push('TEST_EMAIL')
    if (!testPassword) missingVars.push('TEST_PASSWORD')

    if (missingVars.length > 0) {
        console.error('❌ Missing configuration in .env file:')
        missingVars.forEach(v => console.error(`   - ${v}`))
        console.log('\nPlease add these values to backend/.env to run the RLS test.')
        process.exit(1)
    }

    // Initialize Supabase
    const supabase = createClient(supabaseUrl, supabaseKey)

    try {
        // Step 4A: Sign in
        console.log('➡️  Step 4A: Authenticating...')
        const { data: { session }, error: authError } = await supabase.auth.signInWithPassword({
            email: testEmail,
            password: testPassword
        })

        if (authError) throw new Error(`Authentication failed: ${authError.message}`)
        if (!session) throw new Error('No session returned after login')

        console.log(`   ✅ Signed in as user: ${session.user.id}`)
        console.log(`\n🔑 ACCESS_TOKEN: ${session.access_token}\n`)

        // Step 4B: Test profiles SELECT (Own Profile)
        console.log('\n➡️  Step 4B: Testing select on "profiles" (Own Data)')
        console.log('   Executing: supabase.from(\'profiles\').select(\'*\')')

        const { data: myData, error: myError } = await supabase
            .from('profiles')
            .select('*')

        if (myError) {
            console.error('   ❌ Error querying own profile:', myError)
        } else {
            console.log('   Result:', myData)
            if (Array.isArray(myData) && myData.length === 1) {
                console.log('   ✅ Success: Retrieved exactly 1 row (your profile).')
            } else {
                console.warn(`   ⚠️  Warning: Expected 1 row, got ${myData ? myData.length : 0}.`)
            }
        }

        // Step 4C: Prove RLS Restricts Access
        console.log('\n➡️  Step 4C: Testing RLS Restriction (Accessing Other Data)')
        console.log(`   Executing: supabase.from('profiles').select('*').neq('user_id', '${session.user.id}')`)

        const { data: restrictedData, error: restrictedError } = await supabase
            .from('profiles')
            .select('*')
            .neq('user_id', session.user.id)

        if (restrictedError) {
            console.log('   ℹ️  Query returned error (this might be expected depending on policy):', restrictedError.message)
        } else {
            console.log('   Result:', restrictedData)
            if (Array.isArray(restrictedData) && restrictedData.length === 0) {
                console.log('   ✅ Success: RLS prevented access to other profiles (result is empty).')
            } else {
                console.error('   ❌ FAILURE: RLS LEAK! Retrieved data belonging to other users!')
            }
        }

        // Step 4D: Testing select on "churches" (Own Church)
        console.log('\n➡️  Step 4D: Testing select on "churches" (Own Church)')
        console.log('   Executing: supabase.from(\'churches\').select(\'*\')')

        const { data: churches, error: churchesErr } = await supabase
            .from('churches')
            .select('*');

        if (churchesErr) {
            console.error('   ❌ Error querying churches:', churchesErr)
        } else {
            console.log('   Result:', churches)
            if (Array.isArray(churches) && churches.length === 1) {
                console.log('   ✅ Success: Retrieved exactly 1 row (your church).')
            } else if (Array.isArray(churches) && churches.length === 0) {
                console.warn('   ⚠️  Warning: Retrieved 0 churches. Ensure this user is linked to a church in "profiles".')
            } else {
                console.warn(`   ⚠️  Warning: Expected 1 row, got ${churches ? churches.length : 0}. Check RLS if multiple churches exist.`)
            }
        }

        // Step 5: Optional "Hard Proof" with Second User
        const testEmail2 = process.env.TEST_EMAIL_2
        const testPassword2 = process.env.TEST_PASSWORD_2

        if (testEmail2 && testPassword2) {
            console.log('\n➡️  Step 5: Optional "Hard Proof" (Second User without Profile)')
            console.log('   Authenticating as second user...')

            const { data: { session: session2 }, error: authError2 } = await supabase.auth.signInWithPassword({
                email: testEmail2,
                password: testPassword2
            })

            if (authError2) {
                console.warn(`   ⚠️  Could not sign in second user: ${authError2.message}. Skipping Step 5.`)
            } else {
                console.log(`   ✅ Signed in as user 2: ${session2.user.id}`)
                console.log('   Executing: supabase.from(\'profiles\').select(\'*\')')

                const { data: data2, error: error2 } = await supabase
                    .from('profiles')
                    .select('*')

                if (error2) {
                    console.log('   ℹ️  Query returned error:', error2.message)
                } else {
                    console.log('   Result:', data2)
                    if (Array.isArray(data2) && data2.length === 0) {
                        console.log('   ✅ Success: User without profile sees nothing (RLS blocking users without profile).')
                    } else {
                        console.error('   ❌ FAILURE: User 2 saw data! (Should be empty)')
                    }
                }
            }
        } else {
            console.log('\nℹ️  Skipping Step 5 (Second User). Add TEST_EMAIL_2 and TEST_PASSWORD_2 to backend/.env to enable.')
        }

        console.log('\n✅ RLS Test Sequence Complete.')

    } catch (err) {
        console.error('\n❌ Test execution failed:', err.message)
        process.exit(1)
    }
}

runTest()

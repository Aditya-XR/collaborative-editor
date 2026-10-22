import type { ReactNode } from 'react'
import { Link } from 'react-router'

const CONTACT = 'adityaccds@gmail.com'
const linkClass = 'text-indigo-600 underline dark:text-indigo-400'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/** Public, signed in or not: Google's consent screen links here. Keep it true to what the code does. */
export function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-12 text-sm leading-6 text-slate-700 dark:text-slate-300">
      <header className="space-y-2">
        <Link
          to="/"
          className="text-lg font-semibold tracking-tight text-indigo-600 dark:text-indigo-400"
        >
          CollabEdit
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Privacy policy
        </h1>
        <p className="text-slate-500 dark:text-slate-400">Last updated 22 October 2026</p>
      </header>

      <p>
        CollabEdit is a collaborative document editor, built and run by Aditya Kumar as a portfolio
        project. Its{' '}
        <a href="https://github.com/Aditya-XR/collaborative-editor" className={linkClass}>
          source code
        </a>{' '}
        is public. This page says what it stores, why, and how to have it deleted.
      </p>

      <Section title="What CollabEdit stores">
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Your account:</strong> your name, email address and whether you have confirmed
            it. If you set a password, only an Argon2id hash of it is kept, never the password.
          </li>
          <li>
            <strong>If you sign in with Google:</strong> your Google account id, email address, name
            and profile picture address. CollabEdit asks Google only for these (the{' '}
            <code>openid</code>, <code>email</code> and <code>profile</code> scopes) and never sees
            your Google password.
          </li>
          <li>
            <strong>What you write:</strong> your documents, their edit history, versions and
            branches, your comments, and who you share documents with.
          </li>
          <li>
            <strong>Cookies:</strong> one sign-in cookie that keeps you signed in, and during Google
            sign-in a short-lived cookie that ties the request to your browser. There are no
            advertising or analytics cookies.
          </li>
          <li>
            <strong>In your browser:</strong> copies of the documents you open, so you can keep
            editing offline. They are deleted when you sign out.
          </li>
          <li>
            <strong>Your IP address,</strong> only to limit how often requests can be made. These
            counters expire within minutes. The server keeps no access logs.
          </li>
        </ul>
      </Section>

      <Section title="How it is used">
        <p>
          Only to run the app: signing you in, saving and syncing documents, showing collaborators
          who is editing, and sending the emails you would expect (confirming your address, password
          resets and comment notifications). There are no ads, analytics or tracking scripts, and
          your data is not sold or shared with anyone other than the services below.
        </p>
      </Section>

      <Section title="Services that process it">
        <ul className="list-disc space-y-2 pl-5">
          <li>Vercel serves the website.</li>
          <li>
            Render runs the API server; Neon (PostgreSQL) and Redis Cloud store the data. All three
            are in Singapore.
          </li>
          <li>Gmail sends the emails.</li>
          <li>Google handles Google sign-in, if you use it.</li>
        </ul>
      </Section>

      <Section title="Google user data">
        <p>
          CollabEdit's use of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className={linkClass}
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. It is used only to sign you in and to show your
          name to the people you work with.
        </p>
      </Section>

      <Section title="Keeping and deleting your data">
        <p>
          Your data is kept while your account exists. A document moved to the trash can still be
          restored. To delete your account, email{' '}
          <a href={`mailto:${CONTACT}`} className={linkClass}>
            {CONTACT}
          </a>{' '}
          from its address. Deleting it removes your sign-in details, the documents you own with
          their history, and your access to documents others shared with you. Comments and edits you
          made in other people's documents stay there without your name.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          Questions about this policy:{' '}
          <a href={`mailto:${CONTACT}`} className={linkClass}>
            {CONTACT}
          </a>
          .
        </p>
      </Section>
    </main>
  )
}
